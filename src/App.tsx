import { useState } from 'react';
import type { TranscriptDoc } from './types';
import { FileUpload } from './components/FileUpload';
import { Sidebar } from './components/Sidebar';
import { TranscriptView } from './components/TranscriptView';

export default function App() {
  const [doc, setDoc] = useState<TranscriptDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!doc) {
    return (
      <>
        <FileUpload onLoaded={setDoc} onError={setError} />
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
    <div className="flex h-screen bg-gray-50">
      <Sidebar doc={doc} onReset={() => setDoc(null)} />
      <TranscriptView doc={doc} />
    </div>
  );
}
