import { invoke } from "@tauri-apps/api/core";

/** Live gateway status for the Settings → Remote Devices section. */
export interface RemoteStatus {
  running: boolean;
  port: number | null;
  tlsActive: boolean;
  fingerprint: string | null;
  pairingActive: boolean;
  devices: number;
}

/** A paired device, minus its token hash. */
export interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
  connected?: boolean;
}

/** What `remote_pairing_begin` returns: a one-time code + the QR the
 *  phone scans, valid until `expiresAt` (epoch ms). */
export interface PairingBegin {
  code: string;
  expiresAt: number;
  qrPayload: string;
}

export function remoteStatus(): Promise<RemoteStatus> {
  return invoke("remote_status");
}

export function remotePairingBegin(): Promise<PairingBegin> {
  return invoke("remote_pairing_begin");
}

export function remotePairingCancel(): Promise<void> {
  return invoke("remote_pairing_cancel");
}

export function remoteDevicesList(): Promise<RemoteDevice[]> {
  return invoke("remote_devices_list");
}

export function remoteDeviceRevoke(id: string): Promise<void> {
  return invoke("remote_device_revoke", { id });
}

export function remoteDeviceRename(id: string, name: string): Promise<void> {
  return invoke("remote_device_rename", { id, name });
}
