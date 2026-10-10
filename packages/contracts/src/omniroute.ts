export interface NativeGatewayReport {
  available: boolean;
  error?: string;
  truncated: boolean;
  skills: {
    id: string;
    name: string;
    version: string;
    scope: "nova" | "global";
    enabled: boolean | null;
    mode: "on" | "off" | "auto" | null;
  }[];
  documentation: { id: string; name: string; description: string }[];
  prompt: {
    enabled: boolean | null;
    prefixCharacters: number | null;
    suffixCharacters: number | null;
  };
}

export interface NativeSkillDocument {
  available: boolean;
  error?: string;
  id?: string;
  name?: string;
  documentation?: string;
}
