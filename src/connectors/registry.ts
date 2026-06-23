import type { ConnectorProviderDef } from "../core/types.ts";

export const CONNECTOR_PROVIDERS: ConnectorProviderDef[] = [
  {
    id: "github",
    displayName: "GitHub",
    tokenHint: "Paste a GitHub personal access token, or use the GitHub CLI session.",
    tokenHelpUrl: "https://github.com/settings/tokens"
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    tokenHint: "Paste a GitLab personal access token with read_api scope.",
    tokenHelpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens"
  },
  {
    id: "clickup",
    displayName: "ClickUp",
    tokenHint: "Paste your ClickUp personal API token (starts with pk_).",
    tokenHelpUrl: "https://app.clickup.com/settings/apps"
  }
];