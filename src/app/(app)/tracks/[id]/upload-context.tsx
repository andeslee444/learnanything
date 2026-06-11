'use client';

import { useState, useRef, useEffect } from 'react';

type UploadItem = {
  id: string;
  title: string;
  annotation: string;
};

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

type Props = { trackId: string };

export function UploadContext({ trackId }: Props) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadState, setUploadState] = useState<UploadState>({ kind: 'idle' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing uploads on mount
  useEffect(() => {
    fetch(`/api/tracks/${trackId}/uploads`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.uploads) setUploads(data.uploads);
      })
      .catch(() => {}); // silently ignore on mount
  }, [trackId]);

  async function handleFile(file: File) {
    // Client-side type check
    if (!/\.(txt|md)$/i.test(file.name)) {
      setUploadState({ kind: 'error', message: 'Only .txt and .md files are accepted' });
      return;
    }
    if (file.size > 200_000) {
      setUploadState({ kind: 'error', message: 'File must be under 200 KB' });
      return;
    }

    setUploadState({ kind: 'uploading' });

    let text: string;
    try {
      text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsText(file, 'utf-8');
      });
    } catch {
      setUploadState({ kind: 'error', message: 'Could not read the file — please try again' });
      return;
    }

    try {
      const res = await fetch(`/api/tracks/${trackId}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, text }),
      });

      if (res.status === 409) {
        setUploadState({ kind: 'error', message: 'Maximum 10 context files per track reached' });
        return;
      }
      if (res.status === 422) {
        const body = (await res.json()) as { message?: string };
        setUploadState({
          kind: 'error',
          message: body.message ?? 'File could not be processed — please try a different file',
        });
        return;
      }
      if (!res.ok) {
        setUploadState({ kind: 'error', message: 'Upload failed — please try again' });
        return;
      }

      const data = (await res.json()) as { resourceId: string; annotation: string };
      setUploads((prev) => [
        { id: data.resourceId, title: file.name, annotation: data.annotation },
        ...prev,
      ]);
      setUploadState({ kind: 'success' });

      // Reset input so the same file can be re-selected if needed
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch {
      setUploadState({ kind: 'error', message: 'Network error — please check your connection' });
    }
  }

  return (
    <section
      data-testid="upload-context"
      className="mt-8 rounded-xl border border-ink-400/20 bg-cloud p-6 shadow-sm"
      aria-label="Add context"
    >
      <h2 className="text-lg font-medium text-ink-900">Add context</h2>
      <p className="mt-1 text-sm text-ink-600">
        Upload .txt or .md files to give your lessons extra context (up to 10 files, 200 KB each).
      </p>

      {/* File input */}
      <div className="mt-4 flex items-center gap-3">
        <label
          htmlFor="upload-context-input"
          className="cursor-pointer rounded-lg border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 focus-within:ring-2 focus-within:ring-sky-400"
        >
          {uploadState.kind === 'uploading' ? 'Uploading…' : 'Choose file'}
          <input
            id="upload-context-input"
            ref={fileInputRef}
            type="file"
            accept=".txt,.md"
            className="sr-only"
            aria-label="Choose a .txt or .md file to upload as context"
            disabled={uploadState.kind === 'uploading'}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setUploadState({ kind: 'idle' });
                handleFile(file);
              }
            }}
          />
        </label>
        {uploadState.kind === 'success' && (
          <span className="text-sm text-green-600" role="status">
            Uploaded successfully
          </span>
        )}
      </div>

      {/* Error display */}
      {uploadState.kind === 'error' && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {uploadState.message}
        </p>
      )}

      {/* Uploaded files list */}
      {uploads.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Uploaded context files">
          {uploads.map((item) => (
            <li
              key={item.id}
              data-testid="upload-item"
              className="rounded-lg border border-ink-400/15 bg-white px-4 py-3"
            >
              <p className="text-sm font-medium text-ink-900">{item.title}</p>
              <p className="mt-0.5 text-xs text-ink-600">{item.annotation}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
