// ─────────────────────────────────────────────
// Project + chat CRUD handlers (thin db wrappers)
// ─────────────────────────────────────────────
// Extracted from service-worker.ts. Only lib/db deps, no shared worker
// state. CREATE_PROJECT exercised by e2e/capture.spec.ts.

import {
  createProject, listProjects, getProject, updateProjectTitle, updateProjectRules, deleteProject,
  createChat, listChats, updateChatTitle, deleteChat
} from '../lib/db';

export async function handleCreateProject(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const title = (request.title as string) || 'New Project';
  const id = await createProject(title);
  return { id };
}

export async function handleListProjects(): Promise<Record<string, unknown>> {
  const projects = await listProjects();
  return { projects };
}

export async function handleGetProject(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const project = await getProject(request.id as string);
  return { project: project || null };
}

export async function handleUpdateProject(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof request.title === 'string') await updateProjectTitle(request.id as string, request.title);
  if (typeof request.rules === 'string') await updateProjectRules(request.id as string, request.rules as string);
  return {};
}

import { resetSessionIndex } from '../lib/vector-store';

export async function handleDeleteProject(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = request.id as string;
  await deleteProject(id);
  // Clear the in-memory Orama index — without this, queries keep hitting
  // deleted chunks until the service worker restarts.
  resetSessionIndex(id);
  return {};
}

export async function handleCreateChat(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string;
  const title = (request.title as string) || 'New Chat';
  if (!projectId) throw new Error('projectId is required to create a chat');
  const id = await createChat(projectId, title);
  return { id };
}

export async function handleListChats(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string;
  if (!projectId) throw new Error('projectId is required to list chats');
  const chats = await listChats(projectId);
  return { chats };
}

export async function handleDeleteChat(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  await deleteChat(request.id as string);
  return {};
}

export async function handleUpdateChat(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { id, title } = request;
  if (!id || !title) throw new Error('id and title are required to update chat');
  await updateChatTitle(id as string, title as string);
  return {};
}
