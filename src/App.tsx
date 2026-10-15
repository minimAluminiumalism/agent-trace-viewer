import { useState } from 'react';
import type { TranscriptDoc } from './types';
import { FileUpload } from './components/FileUpload';
import { Sidebar } from './components/Sidebar';
import { TranscriptView } from './components/TranscriptView';

export default function App() {
  const [doc, setDoc] = useState<TranscriptDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Basename → objectURL for images dropped alongside (or onto) the viewer.
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());

  function onLoaded(d: TranscriptDoc, images: Map<string, string>) {
    setImageUrls(images);
    setDoc(d);
  }

  function attachImages(files: FileList | File[]) {
    const next = new Map(imageUrls);
    for (const f of Array.from(files)) {
      if (f.type.startsWith('image/')) next.set(f.name, URL.createObjectURL(f));
    }
    setImageUrls(next);
  }

  if (!doc) {
    return (
      <>
        <FileUpload onLoaded={onLoaded} onError={setError} />
        {error && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-red-600 text-white
                          px-4 py-3 rounded-lg shadow-lg text-sm max-w-lg">
            {error}
            <button className="ml-3 underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className="flex h-screen bg-gray-50"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        attachImages(e.dataTransfer.files);
      }}
    >
      <Sidebar doc={doc} onReset={() => setDoc(null)} />
      <TranscriptView doc={doc} imageUrls={imageUrls} />
    </div>
  );
}
