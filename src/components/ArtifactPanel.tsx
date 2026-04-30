'use client';

import { useEffect, useState } from 'react';

export function ArtifactPanel({ runId }: { runId: string }) {
  const [artifact, setArtifact] = useState('');

  useEffect(() => {
    const timer = setInterval(() => {
      fetch(`/api/runs/${runId}/artifact`)
        .then((response) => response.json())
        .then((data) => setArtifact(data.artifact ?? ''))
        .catch(() => undefined);
    }, 1200);
    return () => clearInterval(timer);
  }, [runId]);

  return (
    <div className="card stack">
      <h2>Artifact</h2>
      {artifact ? <pre>{artifact}</pre> : <p>최종 artifact가 생성되면 여기에 표시됩니다.</p>}
    </div>
  );
}
