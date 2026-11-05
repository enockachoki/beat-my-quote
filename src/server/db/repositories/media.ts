import type { Tx } from "../client";
import type { MediaRow } from "../types";

export async function insertPending(
  tx: Tx,
  m: Pick<MediaRow, "jobId" | "uploadedBy" | "kind" | "clientFingerprint" | "originalFilename" | "declaredMime" | "storagePath" | "uploadExpiresAt"> & { sizeBytes: number },
): Promise<{ row: MediaRow; created: boolean }> {
  const inserted = await tx<MediaRow[]>`
    insert into public.media (job_id, uploaded_by, kind, client_fingerprint, original_filename, declared_mime, size_bytes, storage_path, upload_expires_at)
    values (${m.jobId}, ${m.uploadedBy}, ${m.kind}, ${m.clientFingerprint}, ${m.originalFilename}, ${m.declaredMime}, ${m.sizeBytes}, ${m.storagePath}, ${m.uploadExpiresAt})
    on conflict (job_id, client_fingerprint) where status not in ('rejected', 'deleted') do nothing
    returning *`;
  if (inserted[0]) return { row: inserted[0], created: true };
  const [existing] = await tx<MediaRow[]>`
    select * from public.media where job_id = ${m.jobId} and client_fingerprint = ${m.clientFingerprint}
      and status not in ('rejected', 'deleted')`;
  return { row: existing!, created: false };
}

export async function getMedia(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<MediaRow | null> {
  const rows = opts.forUpdate
    ? await tx<MediaRow[]>`select * from public.media where id = ${id} for update`
    : await tx<MediaRow[]>`select * from public.media where id = ${id}`;
  return rows[0] ?? null;
}

export async function listForJob(tx: Tx, jobId: string): Promise<MediaRow[]> {
  return tx<MediaRow[]>`select * from public.media where job_id = ${jobId} and status <> 'deleted' order by created_at limit 200`;
}

export async function listVisibleToBuilders(tx: Tx, jobId: string): Promise<MediaRow[]> {
  return tx<MediaRow[]>`
    select * from public.media where job_id = ${jobId} and visible_to_builders and status = 'ready' and kind <> 'quote_document'
    order by created_at limit 100`;
}

export async function countActive(tx: Tx, jobId: string): Promise<{ total: number; videos: number }> {
  const [row] = await tx<{ total: number; videos: number }[]>`
    select count(*)::int as total, count(*) filter (where kind = 'video')::int as videos
    from public.media where job_id = ${jobId} and status not in ('rejected', 'deleted') and kind <> 'quote_redacted'`;
  return row ?? { total: 0, videos: 0 };
}

export async function update(tx: Tx, id: string, fields: Record<string, unknown>): Promise<MediaRow | null> {
  const [row] = await tx<MediaRow[]>`update public.media set ${tx(fields as Record<string, never>)} where id = ${id} returning *`;
  return row ?? null;
}

export async function claimForProcessing(tx: Tx, limit: number): Promise<MediaRow[]> {
  return tx<MediaRow[]>`
    update public.media set status = 'processing', attempts = attempts + 1
    where id in (
      select id from public.media
      where (status = 'uploaded' or (status = 'processing' and updated_at < now() - interval '10 minutes'))
        and attempts < 5
      order by updated_at limit ${limit} for update skip locked)
    returning *`;
}

export async function staleUploads(tx: Tx, limit: number): Promise<MediaRow[]> {
  return tx<MediaRow[]>`
    select * from public.media where status = 'pending_upload' and upload_expires_at < now() - interval '1 hour'
    order by upload_expires_at limit ${limit} for update skip locked`;
}
