/**
 * Expert AI Module - Uses DuckDuckGo AI Chat (FREE, no login required)
 * DuckDuckGo offers free access to Claude, GPT-4o-mini, Llama, and Mixtral
 * Completely free, no account needed, privacy-focused
 */
export interface AskExpertResult {
    success: boolean;
    response?: string;
    error?: string;
}
/**
 * Ask DuckDuckGo AI Chat - FREE, no login required
 * Uses Claude, GPT-4o-mini, Llama 3, or Mixtral
 */
export declare function askExpertAI(question: string): Promise<AskExpertResult>;
//# sourceMappingURL=browserAI.d.ts.map