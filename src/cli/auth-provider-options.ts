import type { AuthCheck, AuthType } from "@earendil-works/pi-ai";
import type { ModelProviderInfo } from "../model/index.js";
import type { AuthMenuChoice } from "./auth-menu.js";

export interface AuthProviderState {
  savedType?: AuthType;
  auth?: AuthCheck;
  checked: boolean;
  failed?: boolean;
  environment?: "configured" | "partial";
}

export interface AuthProviderChoice extends AuthMenuChoice {
  provider: string;
  authType: AuthType;
}

/** Prime's provider+method rows, adapted to pi-ai's provider-owned metadata. */
export function authProviderChoices(
  providers: readonly ModelProviderInfo[],
  states: ReadonlyMap<string, AuthProviderState> = new Map(),
): AuthProviderChoice[] {
  const rows = providers.flatMap((provider) => provider.authTypes
    .filter((type) => type !== "api_key" || provider.apiKeyLogin !== false)
    .map((authType) => {
      const state = states.get(provider.id);
      const matches = state?.auth?.type === authType || state?.savedType === authType;
      const alternate = state?.savedType !== undefined && state.savedType !== authType;
      let status = "unconfigured";
      if (state === undefined || !state.checked) status = state?.savedType === authType ? "saved" : "checking...";
      else if (state.auth?.type === authType) {
        const source = state.auth.source;
        status = !source || source.toLowerCase() === "oauth" || source.toLowerCase() === "stored credential"
          ? "configured"
          : /^[A-Z][A-Z0-9_]+$/.test(source) ? `env: ${source}` : source;
      } else if (state.savedType === authType) status = state.failed ? "saved; check unavailable" : "saved";
      else if (alternate) status = state.savedType === "oauth" ? "account configured" : "API key configured";
      else if (authType === "api_key" && state.environment === "configured") status = "environment configured";
      else if (authType === "api_key" && state.environment === "partial") status = "setup incomplete";
      else if (state.failed) status = "check unavailable";
      const detail = authType === "oauth"
        ? provider.oauthSubscription === true ? "subscription" : "browser sign-in"
        : provider.apiKeyName !== undefined && !/api key/i.test(provider.apiKeyName)
          ? provider.apiKeyName : "api key";
      return {
        value: `${provider.id}:${authType}`,
        provider: provider.id,
        authType,
        label: authType === "oauth" ? provider.oauthName ?? provider.name : provider.name,
        detail,
        status,
        searchText: `${provider.id} ${authType} ${detail} ${authType === "oauth" ? provider.oauthLoginLabel ?? "" : provider.apiKeyName ?? ""}`,
        rank: matches ? 0 : alternate ? 1 : 2,
      };
    }));
  return rows.sort((left, right) => left.rank - right.rank
    || (left.authType === right.authType ? 0 : left.authType === "oauth" ? -1 : 1)
    || left.label.localeCompare(right.label));
}
