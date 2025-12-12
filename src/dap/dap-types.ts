/**
 * DAP (Debug Adapter Protocol) Type Definitions
 *
 * Types for communicating with Godot's DAP server on port 6006.
 * Based on the Debug Adapter Protocol specification.
 */

// Base DAP message types
export interface DAPMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
}

export interface DAPRequest extends DAPMessage {
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
}

export interface DAPResponse extends DAPMessage {
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  body?: Record<string, unknown>;
  message?: string;
}

export interface DAPEvent extends DAPMessage {
  type: 'event';
  event: string;
  body?: Record<string, unknown>;
}

// Thread information
export interface Thread {
  id: number;
  name: string;
}

// Source location
export interface Source {
  name?: string;
  path?: string;
  sourceReference?: number;
}

// Stack frame from stackTrace request
export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

// Scope from scopes request
export interface Scope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
  namedVariables?: number;
  indexedVariables?: number;
}

// Variable from variables request
export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

// Breakpoint information
export interface Breakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: Source;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

// Breakpoint location for setBreakpoints
export interface SourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

// Initialize request arguments
export interface InitializeRequestArguments {
  clientID?: string;
  clientName?: string;
  adapterID: string;
  locale?: string;
  linesStartAt1?: boolean;
  columnsStartAt1?: boolean;
  pathFormat?: 'path' | 'uri';
  supportsVariableType?: boolean;
  supportsVariablePaging?: boolean;
  supportsRunInTerminalRequest?: boolean;
  supportsMemoryReferences?: boolean;
  supportsProgressReporting?: boolean;
  supportsInvalidatedEvent?: boolean;
  supportsMemoryEvent?: boolean;
}

// Capabilities returned by initialize
export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsStepBack?: boolean;
  supportsSetVariable?: boolean;
  supportsRestartFrame?: boolean;
  supportsGotoTargetsRequest?: boolean;
  supportsStepInTargetsRequest?: boolean;
  supportsCompletionsRequest?: boolean;
  supportsModulesRequest?: boolean;
  supportsRestartRequest?: boolean;
  supportsExceptionOptions?: boolean;
  supportsValueFormattingOptions?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportTerminateDebuggee?: boolean;
  supportSuspendDebuggee?: boolean;
  supportsDelayedStackTraceLoading?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  supportsLogPoints?: boolean;
  supportsTerminateThreadsRequest?: boolean;
  supportsSetExpression?: boolean;
  supportsTerminateRequest?: boolean;
  supportsDataBreakpoints?: boolean;
  supportsReadMemoryRequest?: boolean;
  supportsWriteMemoryRequest?: boolean;
  supportsDisassembleRequest?: boolean;
  supportsCancelRequest?: boolean;
  supportsBreakpointLocationsRequest?: boolean;
  supportsClipboardContext?: boolean;
  supportsSteppingGranularity?: boolean;
  supportsInstructionBreakpoints?: boolean;
  supportsExceptionFilterOptions?: boolean;
  supportsSingleThreadExecutionRequests?: boolean;
}

// Response bodies
export interface ThreadsResponseBody {
  threads: Thread[];
}

export interface StackTraceResponseBody {
  stackFrames: StackFrame[];
  totalFrames?: number;
}

export interface ScopesResponseBody {
  scopes: Scope[];
}

export interface VariablesResponseBody {
  variables: Variable[];
}

export interface SetBreakpointsResponseBody {
  breakpoints: Breakpoint[];
}

// Event bodies
export interface StoppedEventBody {
  reason: 'step' | 'breakpoint' | 'exception' | 'pause' | 'entry' | 'goto' | 'function breakpoint' | 'data breakpoint' | 'instruction breakpoint' | string;
  description?: string;
  threadId?: number;
  preserveFocusHint?: boolean;
  text?: string;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
}

export interface ContinuedEventBody {
  threadId: number;
  allThreadsContinued?: boolean;
}

export interface OutputEventBody {
  category?: 'console' | 'important' | 'stdout' | 'stderr' | 'telemetry' | string;
  output: string;
  group?: 'start' | 'startCollapsed' | 'end';
  variablesReference?: number;
  source?: Source;
  line?: number;
  column?: number;
  data?: unknown;
}

export interface TerminatedEventBody {
  restart?: unknown;
}

// Output formats as specified in KAN-74
export interface GetBreakpointsOutput {
  breakpoints: Array<{
    script: string;
    line: number;
    enabled: boolean;
  }>;
}

export interface GetCallStackOutput {
  paused: boolean;
  stack: Array<{
    function: string;
    script: string;
    line: number;
  }>;
}

export interface GetLocalVariablesOutput {
  variables: Array<{
    name: string;
    type: string;
    value: string;
  }>;
}
