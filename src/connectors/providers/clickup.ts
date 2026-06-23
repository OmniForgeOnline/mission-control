import type { ConnectorResourceOption, CreateTaskInput } from "../../core/types.ts";

type FetchLike = typeof fetch;

interface ClickUpTeam {
  id: string;
  name: string;
}

interface ClickUpList {
  id: string;
  name: string;
}

interface ClickUpTask {
  id: string;
  name: string;
  url?: string;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: token };
}

export async function fetchClickUpAccount(
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<{ accountLabel: string }> {
  const response = await fetchImpl("https://api.clickup.com/api/v2/team", {
    headers: authHeaders(token)
  });
  if (!response.ok) {
    throw new Error(`ClickUp account lookup failed with status ${response.status}`);
  }
  const data = (await response.json()) as { teams?: ClickUpTeam[] };
  const firstTeam = data.teams?.[0];
  return { accountLabel: firstTeam?.name ?? "ClickUp workspace" };
}

export async function fetchClickUpResources(
  token: string,
  teamId?: string,
  fetchImpl: FetchLike = fetch
): Promise<ConnectorResourceOption[]> {
  const teamsResponse = await fetchImpl("https://api.clickup.com/api/v2/team", {
    headers: authHeaders(token)
  });
  if (!teamsResponse.ok) {
    throw new Error(`ClickUp team lookup failed with status ${teamsResponse.status}`);
  }
  const teamsData = (await teamsResponse.json()) as { teams?: ClickUpTeam[] };
  const teams = teamsData.teams ?? [];
  const selectedTeam = teamId ? teams.find((team) => team.id === teamId) : teams[0];
  if (!selectedTeam) {
    return [];
  }

  const spacesResponse = await fetchImpl(`https://api.clickup.com/api/v2/team/${selectedTeam.id}/space?archived=false`, {
    headers: authHeaders(token)
  });
  if (!spacesResponse.ok) {
    throw new Error(`ClickUp space lookup failed with status ${spacesResponse.status}`);
  }
  const spacesData = (await spacesResponse.json()) as { spaces?: Array<{ id: string; name: string }> };
  const resources: ConnectorResourceOption[] = [];
  for (const space of spacesData.spaces ?? []) {
    const foldersResponse = await fetchImpl(
      `https://api.clickup.com/api/v2/space/${space.id}/folder?archived=false`,
      { headers: authHeaders(token) }
    );
    if (!foldersResponse.ok) {
      continue;
    }
    const foldersData = (await foldersResponse.json()) as { folders?: Array<{ id: string; name: string }> };
    for (const folder of foldersData.folders ?? []) {
      const listsResponse = await fetchImpl(
        `https://api.clickup.com/api/v2/folder/${folder.id}/list?archived=false`,
        { headers: authHeaders(token) }
      );
      if (!listsResponse.ok) {
        continue;
      }
      const listsData = (await listsResponse.json()) as { lists?: ClickUpList[] };
      for (const list of listsData.lists ?? []) {
        resources.push({
          id: list.id,
          label: `${selectedTeam.name} / ${space.name} / ${folder.name} / ${list.name}`,
          meta: {
            teamId: selectedTeam.id,
            listId: list.id
          }
        });
      }
    }

    const folderlessResponse = await fetchImpl(
      `https://api.clickup.com/api/v2/space/${space.id}/list?archived=false`,
      { headers: authHeaders(token) }
    );
    if (folderlessResponse.ok) {
      const folderlessData = (await folderlessResponse.json()) as { lists?: ClickUpList[] };
      for (const list of folderlessData.lists ?? []) {
        resources.push({
          id: list.id,
          label: `${selectedTeam.name} / ${space.name} / ${list.name}`,
          meta: {
            teamId: selectedTeam.id,
            listId: list.id
          }
        });
      }
    }
  }
  return resources;
}

export async function importClickUpTasks(options: {
  listId?: string;
  token?: string;
  fetchImpl?: FetchLike;
}): Promise<CreateTaskInput[]> {
  if (!options.listId || !options.token) {
    return [];
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.clickup.com/api/v2/list/${options.listId}/task?archived=false`, {
    headers: authHeaders(options.token)
  });
  if (!response.ok) {
    throw new Error(`ClickUp import failed with status ${response.status}`);
  }
  const data = (await response.json()) as { tasks?: ClickUpTask[] };
  return (data.tasks ?? []).map((task) => ({
    title: `ClickUp ${task.id}: ${task.name}`,
    description: `Imported from ClickUp task ${task.id}`,
    agent: "claude",
    source: "clickup",
    links: task.url ? [{ label: task.id, url: task.url }] : []
  }));
}