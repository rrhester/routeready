// Google Drive API helpers for RouteReady Vault. Reuses the Calendar
// connection's encrypted token store + getAccessToken() refresh path
// (one Google connection per DSP serves both Calendar and Vault), and
// the drive.file scope added in google-oauth-start. Server-side only.
import { getAccessToken, type GCalAccount } from "./google_calendar.ts";

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const FIELDS = "id,name,mimeType,webViewLink,modifiedTime,owners(emailAddress,displayName)";

// New-file mime types for the three supported Google editors.
export const GOOGLE_MIME: Record<string, string> = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
};

// Did the connection grant a Drive scope we can create files with?
export function hasDriveScope(scope: string | null | undefined): boolean {
  return /auth\/drive(\.file)?(\s|$)/.test(scope || "");
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  modifiedTime: string | null;
  owner: string | null;
}

// deno-lint-ignore no-explicit-any
function norm(j: any): DriveFile {
  const o = (j.owners && j.owners[0]) || null;
  return {
    id: String(j.id),
    name: j.name || "",
    mimeType: j.mimeType || "",
    webViewLink: j.webViewLink || null,
    modifiedTime: j.modifiedTime || null,
    owner: o ? (o.emailAddress || o.displayName || null) : null,
  };
}

async function driveCall(token: string, url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `${res.status}`;
    const err = new Error(`drive_${method.toLowerCase()}_failed: ${msg}`);
    // deno-lint-ignore no-explicit-any
    (err as any).status = res.status;
    throw err;
  }
  return json;
}

// Create a blank Google-native file (Doc / Sheet / Slide).
export async function driveCreate(token: string, name: string, mimeType: string): Promise<DriveFile> {
  const url = `${DRIVE}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
  return norm(await driveCall(token, url, "POST", { name, mimeType }));
}

// Copy a template file (must be app-created / app-opened under drive.file).
export async function driveCopy(token: string, fileId: string, name: string): Promise<DriveFile> {
  const url = `${DRIVE}/${encodeURIComponent(fileId)}/copy?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
  return norm(await driveCall(token, url, "POST", { name }));
}

// Fetch current Google-owned metadata for a file (used by the sync job).
export async function driveGet(token: string, fileId: string): Promise<DriveFile> {
  const url = `${DRIVE}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
  return norm(await driveCall(token, url, "GET"));
}

// Rename a Google file (push a RouteReady rename back to Drive).
export async function driveRename(token: string, fileId: string, name: string): Promise<DriveFile> {
  const url = `${DRIVE}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
  return norm(await driveCall(token, url, "PATCH", { name }));
}

export { getAccessToken, type GCalAccount };
