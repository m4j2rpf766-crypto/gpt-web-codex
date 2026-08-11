export const CHATGPT_ORIGIN: string;
export const NORMAL_CHAT_URL: string;
export const SESSION_MEMORY_BOUNDARY_ACK: string;
export const LUNA_TOOL_BINDING_ACK: string;
export function conversationIdFromUrl(value: string): string | null;
export function webSessionIdFromUrl(value: string): string | null;
export function memoryBoundaryPrompt(): string;
export function toolBindingPrompt(webSessionId: string): string;
