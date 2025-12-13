#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as net from 'net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { DAPClient, checkPort } from './dap/dap-client.js';
import {
  GetBreakpointsOutput,
  GetCallStackOutput,
  GetLocalVariablesOutput,
} from './dap/dap-types.js';
import { parseGDScript, getVariableNamesAtLine } from './dap/gdscript-parser.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

const execAsync = promisify(exec);

// Maximum number of runtime errors to keep in buffer (FIFO)
const MAX_RUNTIME_ERRORS = 100;

// Regular expressions for parsing Godot error output
const ERROR_PATTERNS = {
  // Matches: ERROR: <message> or SCRIPT ERROR: <message> or WARNING: <message>
  errorStart: /^(ERROR|SCRIPT ERROR|WARNING):\s*(.+)$/,
  // Matches: at: <function> (<script>:<line>) or at: <function> (res://<script>:<line>)
  atLine: /^\s*at:\s*(\w+)\s*\((?:res:\/\/)?([^:]+):(\d+)\)$/,
  // Alternative format: at: GDScript::reload (res://path/to/script.gd:28)
  atLineAlt: /^\s*at:\s*([^\(]+)\s*\(([^:]+):(\d+)\)$/,
};

/**
 * Interface representing a parsed runtime error from Godot
 */
interface RuntimeError {
  timestamp: number;
  type: 'error' | 'warning';
  message: string;
  script: string;
  line: number;
  function?: string;
}

/**
 * Interface for the structured error buffer
 */
interface RuntimeErrorBuffer {
  errors: RuntimeError[];
  maxSize: number;
}

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
  runtimeErrors: RuntimeErrorBuffer;
  pendingErrorLine: string | null;
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for operation parameters
 */
interface OperationParams {
  [key: string]: any;
}

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;

  // DAP debugger integration
  private dapClient: DAPClient | null = null;
  private bridgeHost: string = '127.0.0.1';
  private bridgePort: number = 6008;
  private dapPort: number = 6006;

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    'project_path': 'projectPath',
    'scene_path': 'scenePath',
    'root_node_type': 'rootNodeType',
    'parent_node_path': 'parentNodePath',
    'node_type': 'nodeType',
    'node_name': 'nodeName',
    'texture_path': 'texturePath',
    'node_path': 'nodePath',
    'output_path': 'outputPath',
    'mesh_item_names': 'meshItemNames',
    'new_path': 'newPath',
    'file_path': 'filePath',
    'directory': 'directory',
    'recursive': 'recursive',
    'scene': 'scene',
    'since_timestamp': 'sinceTimestamp',
    'clear_after_read': 'clearAfterRead',
    // Debugger tool parameters
    'stack_frame': 'stackFrame',
    'thread_id': 'threadId',
    'max_depth': 'maxDepth',
    'dap_port': 'dapPort',
    'bridge_port': 'bridgePort',
  };

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    if (debugMode) console.debug(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.debug(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Parse a stderr line and store structured error if detected
   * @param line The stderr line to parse
   * @param buffer The runtime error buffer
   * @param pendingLine The previous line (if it was an error start without location info)
   * @returns The new pending line state (null if error was completed, or the line if waiting for location)
   */
  private parseAndStoreError(
    line: string,
    buffer: RuntimeErrorBuffer,
    pendingLine: string | null
  ): string | null {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      return pendingLine;
    }

    // Check if this is an "at:" line following an error
    if (pendingLine) {
      const atMatch = trimmedLine.match(ERROR_PATTERNS.atLine) ||
                      trimmedLine.match(ERROR_PATTERNS.atLineAlt);

      if (atMatch) {
        const errorStartMatch = pendingLine.match(ERROR_PATTERNS.errorStart);
        if (errorStartMatch) {
          const errorType = errorStartMatch[1].includes('WARNING') ? 'warning' : 'error';
          const message = errorStartMatch[2];
          const func = atMatch[1].trim();
          let script = atMatch[2];
          const lineNum = parseInt(atMatch[3], 10);

          // Ensure script has res:// prefix
          if (!script.startsWith('res://')) {
            script = `res://${script}`;
          }

          const runtimeError: RuntimeError = {
            timestamp: Date.now() / 1000, // Unix timestamp in seconds
            type: errorType,
            message: message,
            script: script,
            line: lineNum,
            function: func,
          };

          // FIFO: Remove oldest if at max capacity
          if (buffer.errors.length >= buffer.maxSize) {
            buffer.errors.shift();
          }
          buffer.errors.push(runtimeError);

          this.logDebug(`Captured runtime ${errorType}: ${message} at ${script}:${lineNum}`);
          return null; // Clear pending line
        }
      }

      // If the next line is not an "at:" line, store the error without location info
      const errorStartMatch = pendingLine.match(ERROR_PATTERNS.errorStart);
      if (errorStartMatch) {
        const errorType = errorStartMatch[1].includes('WARNING') ? 'warning' : 'error';
        const message = errorStartMatch[2];

        const runtimeError: RuntimeError = {
          timestamp: Date.now() / 1000,
          type: errorType,
          message: message,
          script: '',
          line: 0,
        };

        // FIFO: Remove oldest if at max capacity
        if (buffer.errors.length >= buffer.maxSize) {
          buffer.errors.shift();
        }
        buffer.errors.push(runtimeError);

        this.logDebug(`Captured runtime ${errorType} (no location): ${message}`);
      }
    }

    // Check if this is the start of an error/warning
    const errorMatch = trimmedLine.match(ERROR_PATTERNS.errorStart);
    if (errorMatch) {
      // Store the error type and message, wait for "at:" line
      return trimmedLine;
    }

    return null;
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      const command = path === 'godot' ? 'godot --version' : `"${path}" --version`;
      await execAsync(command);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.warn(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.warn(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.warn(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.warn(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') {
      return params;
    }
    
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        let normalizedKey = key;
        
        // If the key is in snake_case, convert it to camelCase using our mapping
        if (key.includes('_') && this.parameterMappings[key]) {
          normalizedKey = this.parameterMappings[key];
        }
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        } else {
          result[normalizedKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        // Convert camelCase to snake_case
        const snakeKey = this.reverseParameterMappings[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);
      // Escape single quotes in the JSON string to prevent command injection
      const escapedParams = paramsJson.replace(/'/g, "'\\''");
      // On Windows, cmd.exe does not strip single quotes, so we use
      // double quotes and escape them to ensure the JSON is parsed
      // correctly by Godot.
      const isWindows = process.platform === 'win32';
      const quotedParams = isWindows
        ? `\"${paramsJson.replace(/\"/g, '\\"')}\"`
        : `'${escapedParams}'`;


      // Add debug arguments if debug mode is enabled
      const debugArgs = GODOT_DEBUG_MODE ? ['--debug-godot'] : [];

      // Construct the command with the operation and JSON parameters
      const cmd = [
        `"${this.godotPath}"`,
        '--headless',
        '--path',
        `"${projectPath}"`,
        '--script',
        `"${this.operationsScriptPath}"`,
        operation,
        quotedParams, // Pass the JSON string as a single argument
        ...debugArgs,
      ].join(' ');

      this.logDebug(`Command: ${cmd}`);

      const { stdout, stderr } = await execAsync(cmd);

      return { stdout, stderr };
    } catch (error: unknown) {
      // If execAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout,
          stderr: execError.stderr,
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'launch_editor',
          description: 'Launch Godot editor for a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project',
          description: 'Run the Godot project and capture output',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'Optional: Specific scene to run',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_debug_output',
          description: 'Get the current debug output and errors',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_runtime_errors',
          description: 'Get runtime errors, warnings, and push_error()/push_warning() calls from the running Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              since_timestamp: {
                type: 'number',
                description: 'Only return errors after this Unix timestamp (optional)',
              },
              severity: {
                type: 'string',
                enum: ['all', 'error', 'warning'],
                description: 'Filter by severity level (default: "all")',
              },
              clear_after_read: {
                type: 'boolean',
                description: 'Clear the error buffer after reading (default: false)',
              },
            },
            required: [],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the installed Godot version',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_projects',
          description: 'List Godot projects in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to search for Godot projects',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively (default: false)',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Retrieve metadata about a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path where the scene file will be saved (relative to project)',
              },
              rootNodeType: {
                type: 'string',
                description: 'Type of the root node (e.g., Node2D, Node3D)',
                default: 'Node2D',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              parentNodePath: {
                type: 'string',
                description: 'Path to the parent node (e.g., "root" or "root/Player")',
                default: 'root',
              },
              nodeType: {
                type: 'string',
                description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
              },
              nodeName: {
                type: 'string',
                description: 'Name for the new node',
              },
              properties: {
                type: 'object',
                description: 'Optional properties to set on the node',
              },
            },
            required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite into a Sprite2D node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
              },
              texturePath: {
                type: 'string',
                description: 'Path to the texture file (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
          },
        },
        {
          name: 'export_mesh_library',
          description: 'Export a scene as a MeshLibrary resource',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (.tscn) to export',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the mesh library (.res) will be saved',
              },
              meshItemNames: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional: Names of specific mesh items to include (defaults to all)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save changes to a scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              newPath: {
                type: 'string',
                description: 'Optional: New path to save the scene to (for creating variants)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'get_uid',
          description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              filePath: {
                type: 'string',
                description: 'Path to the file (relative to project) for which to get the UID',
              },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'update_project_uids',
          description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        // Debugger integration tools
        {
          name: 'connect_debugger',
          description: 'Connect to Godot editor DAP server for debugging. Requires editor running with MCP Bridge plugin enabled.',
          inputSchema: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: 'Host address (default: 127.0.0.1)',
                default: '127.0.0.1',
              },
              dapPort: {
                type: 'number',
                description: 'DAP port for debugger (default: 6006)',
                default: 6006,
              },
              bridgePort: {
                type: 'number',
                description: 'MCP Bridge plugin port (default: 6008)',
                default: 6008,
              },
            },
            required: [],
          },
        },
        {
          name: 'run_project_debug',
          description: 'Run project in debug mode via the Godot editor. Requires editor open with MCP Bridge plugin.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to project (for verification)',
              },
              scene: {
                type: 'string',
                description: 'Optional: specific scene to run (res:// path)',
              },
            },
            required: [],
          },
        },
        {
          name: 'get_breakpoints',
          description: 'Get all breakpoints in the debugging session',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_call_stack',
          description: 'Get call stack when paused at breakpoint',
          inputSchema: {
            type: 'object',
            properties: {
              threadId: {
                type: 'number',
                description: 'Thread ID to get stack for (default: 1)',
                default: 1,
              },
            },
            required: [],
          },
        },
        {
          name: 'get_local_variables',
          description: 'Get local variables at stack frame',
          inputSchema: {
            type: 'object',
            properties: {
              stackFrame: {
                type: 'number',
                description: 'Stack frame index (0 = current frame, default: 0)',
                default: 0,
              },
              maxDepth: {
                type: 'number',
                description: 'Maximum depth for nested object expansion (default: 2)',
                default: 2,
              },
            },
            required: [],
          },
        },
        {
          name: 'get_signals',
          description: 'Get all signals defined on a node in the currently edited scene. Requires Godot editor with MCP Bridge plugin enabled.',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to node relative to scene root (e.g., "Player", "Player/Sprite2D"). Empty or "." for root node.',
                default: '.',
              },
              includeBuiltin: {
                type: 'boolean',
                description: 'Include inherited/built-in signals (default: true)',
                default: true,
              },
            },
            required: [],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      switch (request.params.name) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments);
        case 'get_debug_output':
          return await this.handleGetDebugOutput();
        case 'get_runtime_errors':
          return await this.handleGetRuntimeErrors(request.params.arguments);
        case 'stop_project':
          return await this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'create_scene':
          return await this.handleCreateScene(request.params.arguments);
        case 'add_node':
          return await this.handleAddNode(request.params.arguments);
        case 'load_sprite':
          return await this.handleLoadSprite(request.params.arguments);
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(request.params.arguments);
        case 'save_scene':
          return await this.handleSaveScene(request.params.arguments);
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        // Debugger integration tools
        case 'connect_debugger':
          return await this.handleConnectDebugger(request.params.arguments);
        case 'run_project_debug':
          return await this.handleRunProjectDebug(request.params.arguments);
        case 'get_breakpoints':
          return await this.handleGetBreakpoints();
        case 'get_call_stack':
          return await this.handleGetCallStack(request.params.arguments);
        case 'get_local_variables':
          return await this.handleGetLocalVariables(request.params.arguments);
        case 'get_signals':
          return await this.handleGetSignals(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${args.projectPath}.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
      }

      const cmdArgs = ['-d', '--path', args.projectPath];
      if (args.scene && this.validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        cmdArgs.push(args.scene);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe' });
      const output: string[] = [];
      const errors: string[] = [];
      const runtimeErrors: RuntimeErrorBuffer = {
        errors: [],
        maxSize: MAX_RUNTIME_ERRORS,
      };
      let pendingErrorLine: string | null = null;

      process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) {
            this.logDebug(`[Godot stderr] ${line}`);
            // Parse errors in real-time and update pending line state
            pendingErrorLine = this.parseAndStoreError(line, runtimeErrors, pendingErrorLine);
          }
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = { process, output, errors, runtimeErrors, pendingErrorLine };

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output,
              errors: this.activeProcess.errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_runtime_errors tool
   * Returns structured runtime errors with filtering options
   */
  private async handleGetRuntimeErrors(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
      );
    }

    // Get a copy of errors for filtering
    let errors = [...this.activeProcess.runtimeErrors.errors];

    // Filter by timestamp if provided
    if (args.sinceTimestamp !== undefined) {
      const sinceTimestamp = parseFloat(args.sinceTimestamp);
      if (!isNaN(sinceTimestamp)) {
        errors = errors.filter(e => e.timestamp > sinceTimestamp);
      }
    }

    // Filter by severity if provided
    if (args.severity && args.severity !== 'all') {
      errors = errors.filter(e => e.type === args.severity);
    }

    // Count errors and warnings
    const errorCount = errors.filter(e => e.type === 'error').length;
    const warningCount = errors.filter(e => e.type === 'warning').length;

    // Clear buffer after read if requested
    if (args.clearAfterRead === true) {
      this.activeProcess.runtimeErrors.errors = [];
    }

    // Format errors with human-readable timestamps
    const formattedErrors = errors.map(e => ({
      ...e,
      time: new Date(e.timestamp * 1000).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      }),
    }));

    const response = {
      errors: formattedErrors,
      error_count: errorCount,
      warning_count: warningCount,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    this.logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    this.activeProcess = null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execAsync(`"${this.godotPath}" --version`);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execAsync(`"${this.godotPath}" --version`, execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const fs = require('fs');
        const projectFileContent = fs.readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType: args.rootNodeType || 'Node2D',
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to export mesh library: ${stderr}`,
          [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execAsync(`"${this.godotPath}" --version`);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execAsync(`"${this.godotPath}" --version`);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  // ============================================================================
  // Debugger Integration Handlers
  // ============================================================================

  /**
   * Send a command to the MCP Bridge plugin via TCP
   * @param command The command to send
   * @returns The response from the plugin
   */
  private async sendBridgeCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let response = '';

      socket.setTimeout(5000);

      socket.on('connect', () => {
        socket.write(command);
      });

      socket.on('data', (data: Buffer) => {
        response += data.toString();
        socket.destroy();
      });

      socket.on('close', () => {
        resolve(response || 'NO_RESPONSE');
      });

      socket.on('error', (err: Error) => {
        reject(err);
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Bridge command timeout'));
      });

      socket.connect(this.bridgePort, this.bridgeHost);
    });
  }

  /**
   * Handle the connect_debugger tool
   * Connects to both the MCP Bridge plugin and the DAP server
   */
  private async handleConnectDebugger(args: any) {
    args = this.normalizeParameters(args);
    const host = args.host || '127.0.0.1';
    const dapPort = args.dapPort || 6006;
    const bridgePort = args.bridgePort || 6008;

    this.logDebug(`Connecting to debugger at ${host}:${dapPort} and bridge at ${host}:${bridgePort}`);

    try {
      // 1. Check if MCP Bridge plugin is reachable
      const bridgeReachable = await checkPort(host, bridgePort);
      if (!bridgeReachable) {
        return this.createErrorResponse(
          'MCP Bridge plugin not detected',
          [
            'Open Godot editor with your project',
            'Enable the MCP Bridge plugin in Project > Project Settings > Plugins',
            `Ensure port ${bridgePort} is not blocked`,
            'Copy the plugin from godot-mcp/src/editor-plugin/ to your project\'s addons/mcp_bridge/ folder',
          ]
        );
      }

      // Ping the bridge to verify it's responding
      try {
        const pingResponse = await this.sendBridgeCommand('ping');
        if (!pingResponse.includes('PONG')) {
          return this.createErrorResponse(
            'MCP Bridge plugin not responding correctly',
            [
              'Check the Godot editor output for errors',
              'Try disabling and re-enabling the plugin',
            ]
          );
        }
      } catch (err) {
        return this.createErrorResponse(
          `MCP Bridge plugin communication error: ${(err as Error).message}`,
          [
            'Check if the Godot editor is still running',
            'Try restarting the Godot editor',
          ]
        );
      }

      // 2. Check if DAP is reachable
      const dapReachable = await checkPort(host, dapPort);
      if (!dapReachable) {
        return this.createErrorResponse(
          'DAP server not detected',
          [
            'Enable Debug > Keep Debug Server Open in the editor',
            'Check Editor > Editor Settings > Network > Debug Adapter',
            `Ensure DAP port ${dapPort} is not blocked`,
          ]
        );
      }

      // 3. Connect DAP client
      if (this.dapClient) {
        this.dapClient.disconnect();
      }

      this.dapClient = new DAPClient();
      await this.dapClient.connect(host, dapPort);
      await this.dapClient.initialize();

      // 4. Store bridge connection info
      this.bridgeHost = host;
      this.bridgePort = bridgePort;
      this.dapPort = dapPort;

      return {
        content: [
          {
            type: 'text',
            text: `Connected to Godot debugger successfully.\n\n` +
                  `DAP Server: ${host}:${dapPort}\n` +
                  `MCP Bridge: ${host}:${bridgePort}\n\n` +
                  `You can now use run_project_debug, get_breakpoints, get_call_stack, and get_local_variables.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to connect to debugger: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot editor is running with your project open',
          'Enable the MCP Bridge plugin',
          'Enable Debug > Keep Debug Server Open',
        ]
      );
    }
  }

  /**
   * Handle the run_project_debug tool
   * Runs the project via the Godot editor using the MCP Bridge plugin
   */
  private async handleRunProjectDebug(args: any) {
    args = this.normalizeParameters(args);

    // Check if we have a bridge connection
    if (!this.bridgePort) {
      return this.createErrorResponse(
        'Not connected to editor',
        ['Use connect_debugger first to establish connection']
      );
    }

    try {
      // Verify bridge is still reachable
      const bridgeReachable = await checkPort(this.bridgeHost, this.bridgePort);
      if (!bridgeReachable) {
        return this.createErrorResponse(
          'Lost connection to MCP Bridge plugin',
          [
            'Ensure Godot editor is still running',
            'Use connect_debugger to reconnect',
          ]
        );
      }

      // Send command to MCP Bridge plugin
      const command = args.scene
        ? `play_scene:${args.scene}`
        : 'play_main';

      const response = await this.sendBridgeCommand(command);

      if (response.startsWith('ERROR:')) {
        return this.createErrorResponse(
          `Bridge error: ${response}`,
          [
            'Check the Godot editor for more details',
            'Ensure a main scene is set in project settings',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project started in debug mode.\n\nResponse: ${response}\n\n` +
                  `Set breakpoints in the Godot editor, then use get_call_stack and get_local_variables when paused.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to run project: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot editor is still running',
          'Use connect_debugger to reconnect',
        ]
      );
    }
  }

  /**
   * Handle the get_breakpoints tool
   * Returns all breakpoints tracked by the DAP client
   */
  private async handleGetBreakpoints() {
    if (!this.dapClient || !this.dapClient.isConnected()) {
      return this.createErrorResponse(
        'Not connected to debugger',
        ['Use connect_debugger first to establish connection']
      );
    }

    try {
      const breakpoints = this.dapClient.getBreakpoints();

      const output: GetBreakpointsOutput = {
        breakpoints: breakpoints,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get breakpoints: ${error?.message || 'Unknown error'}`,
        [
          'Ensure debugger is still connected',
          'Use connect_debugger to reconnect',
        ]
      );
    }
  }

  /**
   * Handle the get_call_stack tool
   * Returns the call stack when paused at a breakpoint
   */
  private async handleGetCallStack(args: any) {
    args = this.normalizeParameters(args);

    if (!this.dapClient || !this.dapClient.isConnected()) {
      return this.createErrorResponse(
        'Not connected to debugger',
        ['Use connect_debugger first to establish connection']
      );
    }

    try {
      const threadId = args.threadId || this.dapClient.getCurrentThreadId();
      const isPaused = this.dapClient.isPaused();

      if (!isPaused) {
        const output: GetCallStackOutput = {
          paused: false,
          stack: [],
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      }

      // Get stack trace from DAP
      const stackFrames = await this.dapClient.stackTrace(threadId);

      const output: GetCallStackOutput = {
        paused: true,
        stack: stackFrames.map(frame => ({
          function: frame.name,
          script: frame.source?.path || frame.source?.name || 'unknown',
          line: frame.line,
        })),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get call stack: ${error?.message || 'Unknown error'}`,
        [
          'Ensure debugger is still connected',
          'Ensure the project is paused at a breakpoint',
        ]
      );
    }
  }

  /**
   * Handle the get_local_variables tool
   * Returns local variables at a specific stack frame
   *
   * Since Godot's DAP doesn't properly return scopes, we use script parsing
   * to discover variable names and then evaluate them individually.
   */
  private async handleGetLocalVariables(args: any) {
    args = this.normalizeParameters(args);

    if (!this.dapClient || !this.dapClient.isConnected()) {
      return this.createErrorResponse(
        'Not connected to debugger',
        ['Use connect_debugger first to establish connection']
      );
    }

    try {
      const stackFrame = args.stackFrame || 0;
      const threadId = this.dapClient.getCurrentThreadId();

      // Get stack trace to get frame info (script path and line)
      const stackFrames = await this.dapClient.stackTrace(threadId);

      if (stackFrames.length === 0) {
        // Not paused - return empty but indicate status
        const output: GetLocalVariablesOutput = {
          variables: [],
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...output,
                note: 'Not paused at breakpoint. Set a breakpoint and trigger it to inspect variables.',
              }, null, 2),
            },
          ],
        };
      }

      if (stackFrame >= stackFrames.length) {
        return this.createErrorResponse(
          `Stack frame ${stackFrame} does not exist`,
          [`Valid stack frames: 0 to ${stackFrames.length - 1}`]
        );
      }

      const frame = stackFrames[stackFrame];
      const frameId = frame.id;
      const scriptPath = frame.source?.path || '';
      const line = frame.line;

      // Parse the script to discover variable names
      let variableNames: string[] = ['self']; // Always include self
      if (scriptPath && existsSync(scriptPath)) {
        try {
          const scriptInfo = parseGDScript(scriptPath);
          variableNames = getVariableNamesAtLine(scriptInfo, line);
          this.logDebug(`Discovered variables at ${scriptPath}:${line}: ${variableNames.join(', ')}`);
        } catch (parseErr) {
          this.logDebug(`Failed to parse script ${scriptPath}: ${parseErr}`);
        }
      }

      // Also add common implicit variables
      if (frame.name && frame.name !== '_ready' && frame.name !== '_init') {
        // For _process, _physics_process, etc., add 'delta'
        if (frame.name.includes('process')) {
          if (!variableNames.includes('delta')) {
            variableNames.push('delta');
          }
        }
      }

      // Evaluate each variable using DAP
      const allVariables: Array<{ name: string; type: string; value: string }> = [];

      for (const varName of variableNames) {
        try {
          const result = await this.dapClient.evaluate(varName, frameId);
          if (result) {
            // Try to infer type from the value
            let inferredType = 'Variant';
            const val = result.result;

            if (val.startsWith('(') && val.includes(',')) {
              // Vector2, Vector3, etc.
              const commaCount = (val.match(/,/g) || []).length;
              if (commaCount === 1) inferredType = 'Vector2';
              else if (commaCount === 2) inferredType = 'Vector3';
              else if (commaCount === 3) inferredType = 'Vector4/Color';
            } else if (val === 'true' || val === 'false') {
              inferredType = 'bool';
            } else if (val.match(/^-?\d+$/)) {
              inferredType = 'int';
            } else if (val.match(/^-?\d+\.\d+$/)) {
              inferredType = 'float';
            } else if (val.startsWith('"') || val.startsWith("'")) {
              inferredType = 'String';
            } else if (val.startsWith('[')) {
              inferredType = 'Array';
            } else if (val.startsWith('{')) {
              inferredType = 'Dictionary';
            } else if (val.includes('<') && val.includes('>')) {
              // Object reference like <EncodedObjectAsID#...>
              inferredType = 'Object';
            } else if (val === 'null' || val === '<null>') {
              inferredType = 'null';
            }

            allVariables.push({
              name: varName,
              type: inferredType,
              value: val,
            });
          }
        } catch (evalErr) {
          // Variable might not exist in current scope, skip silently
          this.logDebug(`Failed to evaluate '${varName}': ${evalErr}`);
        }
      }

      const output: GetLocalVariablesOutput = {
        variables: allVariables,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get local variables: ${error?.message || 'Unknown error'}`,
        [
          'Ensure debugger is still connected',
          'Ensure the project is paused at a breakpoint',
        ]
      );
    }
  }

  /**
   * Handle the get_signals tool
   * Gets all signals defined on a node in the edited scene via MCP Bridge
   */
  private async handleGetSignals(args: any) {
    args = this.normalizeParameters(args);

    // Check if we have a bridge connection
    if (!this.bridgePort) {
      return this.createErrorResponse(
        'Not connected to editor',
        [
          'Use connect_debugger first to establish connection to the Godot editor',
          'Ensure the MCP Bridge plugin is enabled in the editor',
        ]
      );
    }

    try {
      // Verify bridge is still reachable
      const bridgeReachable = await checkPort(this.bridgeHost, this.bridgePort);
      if (!bridgeReachable) {
        return this.createErrorResponse(
          'Lost connection to MCP Bridge plugin',
          [
            'Check if the Godot editor is still running',
            'Use connect_debugger to reconnect',
          ]
        );
      }

      const nodePath = args.nodePath || '.';
      const includeBuiltin = args.includeBuiltin ?? true;

      const response = await this.sendBridgeCommand(`get_signals:${nodePath}`);

      if (response.startsWith('ERROR:NO_SCENE_OPEN')) {
        return this.createErrorResponse(
          'No scene is currently open in the editor',
          ['Open a scene in the Godot editor first']
        );
      }

      if (response.startsWith('ERROR:NODE_NOT_FOUND:')) {
        const path = response.split(':')[2];
        return this.createErrorResponse(
          `Node not found: ${path}`,
          [
            'Check that the node path is correct',
            'Node path should be relative to the scene root',
            'Use "." or empty string for the root node',
          ]
        );
      }

      if (response.startsWith('SIGNALS:')) {
        const jsonStr = response.substring(8);
        const signalsData = JSON.parse(jsonStr);

        // Filter out builtin signals if requested
        if (!includeBuiltin) {
          signalsData.signals = signalsData.signals.filter(
            (sig: any) => sig.source === 'custom'
          );
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(signalsData, null, 2),
          }],
        };
      }

      return this.createErrorResponse(
        `Unexpected response from bridge: ${response}`,
        ['Check the Godot editor for errors']
      );
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get signals: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot editor is still running',
          'Use connect_debugger to reconnect',
        ]
      );
    }
  }

  /**
   * Expand a variable's value, recursively expanding objects up to maxDepth
   */
  private async expandVariableValue(
    variable: { name: string; value: string; variablesReference: number },
    maxDepth: number,
    currentDepth: number
  ): Promise<string> {
    // If variable has no children or we've reached max depth, return the value as-is
    if (variable.variablesReference === 0 || currentDepth >= maxDepth) {
      if (variable.variablesReference !== 0 && currentDepth >= maxDepth) {
        return `${variable.value} [depth limit]`;
      }
      return variable.value;
    }

    // Variable has children, expand them
    try {
      const children = await this.dapClient!.variables(variable.variablesReference);

      if (children.length === 0) {
        return variable.value;
      }

      // Build a representation of the object
      const childValues: string[] = [];
      for (const child of children.slice(0, 10)) { // Limit to 10 children
        const childValue = await this.expandVariableValue(child, maxDepth, currentDepth + 1);
        childValues.push(`${child.name}: ${childValue}`);
      }

      if (children.length > 10) {
        childValues.push(`... and ${children.length - 10} more`);
      }

      return `{ ${childValues.join(', ')} }`;
    } catch (err) {
      return variable.value;
    }
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.warn(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.warn('[SERVER] This may cause issues when executing Godot commands');
          console.warn('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.log(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
