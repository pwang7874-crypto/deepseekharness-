import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-pet-voice-v2";
export declare const inject: string[];
/**
 * Emits only presentation events. Keep DSH-version-specific session listeners in
 * a small adapter beside this plugin; the desktop protocol intentionally stays stable.
 */
export declare function apply(ctx: Context, config: any): void;
