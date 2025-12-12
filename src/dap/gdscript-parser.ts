/**
 * GDScript Parser for Variable Discovery
 *
 * Parses GDScript files to extract variable names that are in scope
 * at a given line number. Used to work around Godot's DAP not returning
 * scopes/locals properly.
 */

import { readFileSync } from 'fs';

/**
 * Information about a variable in the script
 */
export interface VariableInfo {
  name: string;
  type?: string;
  line: number;
  scope: 'class' | 'local' | 'parameter';
}

/**
 * Information about a function in the script
 */
export interface FunctionInfo {
  name: string;
  startLine: number;
  endLine: number;
  parameters: string[];
  localVariables: VariableInfo[];
}

/**
 * Parsed script information
 */
export interface ScriptInfo {
  classVariables: VariableInfo[];
  functions: FunctionInfo[];
}

/**
 * Parse a GDScript file and extract variable information
 */
export function parseGDScript(filePath: string): ScriptInfo {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { classVariables: [], functions: [] };
  }

  return parseGDScriptContent(content);
}

/**
 * Parse GDScript content string
 */
export function parseGDScriptContent(content: string): ScriptInfo {
  const lines = content.split('\n');
  const classVariables: VariableInfo[] = [];
  const functions: FunctionInfo[] = [];

  let currentFunction: FunctionInfo | null = null;
  let indentLevel = 0;
  let functionIndent = 0;

  // Patterns for variable declarations
  const classVarPattern = /^(var|const|@onready\s+var|@export\s+var)\s+(\w+)/;
  const localVarPattern = /^\s+(var|const)\s+(\w+)/;
  const funcPattern = /^func\s+(\w+)\s*\(([^)]*)\)/;
  const forPattern = /^\s+for\s+(\w+)\s+in/;
  const assignPattern = /^\s+(\w+)\s*:?=\s*/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmedLine = line.trimStart();
    const currentIndent = line.length - line.trimStart().length;

    // Check if we've exited the current function
    if (currentFunction && trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
      if (currentIndent <= functionIndent && !line.match(/^\s*$/)) {
        // We've dedented past the function level
        currentFunction.endLine = i; // Previous line was the end
        functions.push(currentFunction);
        currentFunction = null;
      }
    }

    // Skip empty lines and comments for parsing
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }

    // Check for function definition
    const funcMatch = line.match(funcPattern);
    if (funcMatch) {
      // Save previous function if exists
      if (currentFunction) {
        currentFunction.endLine = i;
        functions.push(currentFunction);
      }

      const funcName = funcMatch[1];
      const paramsStr = funcMatch[2];
      const parameters = parseParameters(paramsStr);

      currentFunction = {
        name: funcName,
        startLine: lineNum,
        endLine: lineNum, // Will be updated
        parameters,
        localVariables: [],
      };
      functionIndent = currentIndent;

      // Add parameters as local variables
      for (const param of parameters) {
        currentFunction.localVariables.push({
          name: param,
          line: lineNum,
          scope: 'parameter',
        });
      }
      continue;
    }

    // Check for class-level variable (not indented, or single indent for inner class)
    if (currentIndent === 0) {
      const classVarMatch = line.match(classVarPattern);
      if (classVarMatch) {
        const varName = classVarMatch[2];
        const typeMatch = line.match(new RegExp(`${varName}\\s*:\\s*(\\w+)`));
        classVariables.push({
          name: varName,
          type: typeMatch ? typeMatch[1] : undefined,
          line: lineNum,
          scope: 'class',
        });
        continue;
      }
    }

    // Check for local variables inside functions
    if (currentFunction) {
      // var/const declaration
      const localVarMatch = line.match(localVarPattern);
      if (localVarMatch) {
        const varName = localVarMatch[2];
        const typeMatch = line.match(new RegExp(`${varName}\\s*:\\s*(\\w+)`));
        currentFunction.localVariables.push({
          name: varName,
          type: typeMatch ? typeMatch[1] : undefined,
          line: lineNum,
          scope: 'local',
        });
        continue;
      }

      // for loop variable
      const forMatch = line.match(forPattern);
      if (forMatch) {
        currentFunction.localVariables.push({
          name: forMatch[1],
          line: lineNum,
          scope: 'local',
        });
        continue;
      }

      // Assignment that might introduce a variable (GDScript allows implicit declaration)
      // Only count if it looks like a new variable (simple name = value)
      const assignMatch = line.match(assignPattern);
      if (assignMatch) {
        const varName = assignMatch[1];
        // Check if it's not already declared and not a property access
        const alreadyDeclared =
          currentFunction.localVariables.some(v => v.name === varName) ||
          classVariables.some(v => v.name === varName);

        // Skip if it looks like a property or method call or is 'self'
        if (!alreadyDeclared && !varName.includes('.') && varName !== 'self') {
          currentFunction.localVariables.push({
            name: varName,
            line: lineNum,
            scope: 'local',
          });
        }
      }
    }
  }

  // Don't forget the last function
  if (currentFunction) {
    currentFunction.endLine = lines.length;
    functions.push(currentFunction);
  }

  return { classVariables, functions };
}

/**
 * Parse function parameters from the parameter string
 */
function parseParameters(paramsStr: string): string[] {
  if (!paramsStr.trim()) return [];

  const params: string[] = [];
  const parts = paramsStr.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    // Extract just the parameter name (before : or =)
    const match = trimmed.match(/^(\w+)/);
    if (match) {
      params.push(match[1]);
    }
  }

  return params;
}

/**
 * Get all variables in scope at a given line number
 */
export function getVariablesAtLine(scriptInfo: ScriptInfo, line: number): VariableInfo[] {
  const variables: VariableInfo[] = [];

  // Always include class variables
  variables.push(...scriptInfo.classVariables);

  // Find the function containing this line
  for (const func of scriptInfo.functions) {
    if (line >= func.startLine && line <= func.endLine) {
      // Add parameters and local variables declared before this line
      for (const localVar of func.localVariables) {
        if (localVar.line <= line) {
          variables.push(localVar);
        }
      }
      break; // Found our function
    }
  }

  return variables;
}

/**
 * Get variable names to evaluate at a given line
 * Returns unique variable names that should be in scope
 */
export function getVariableNamesAtLine(scriptInfo: ScriptInfo, line: number): string[] {
  const variables = getVariablesAtLine(scriptInfo, line);
  const names = new Set<string>();

  // Always include 'self' for instance context
  names.add('self');

  for (const v of variables) {
    names.add(v.name);
  }

  return Array.from(names);
}

/**
 * Convert a Windows/absolute path to a res:// path given a project root
 */
export function toResPath(absolutePath: string, projectRoot: string): string {
  // Normalize paths
  const normalizedAbs = absolutePath.replace(/\\/g, '/').toLowerCase();
  const normalizedRoot = projectRoot.replace(/\\/g, '/').toLowerCase();

  if (normalizedAbs.startsWith(normalizedRoot)) {
    const relative = absolutePath.substring(projectRoot.length).replace(/\\/g, '/');
    return 'res:/' + relative;
  }

  return absolutePath;
}
