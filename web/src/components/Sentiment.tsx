import { useEffect, useState } from 'react';
import { api, type BusinessSentiment, type PersonSentiment } from '../api';
import { STANCE_COLORS, toneColor } from '../theme';

const VERDICTS: Record<string, { text: string; color: string }> = {
  positive: { text: 'Generally positive', color: '#34d399' },
  neutral: { text: 'Mostly neutral', color: '#94a3b8' },
  negative: { text: 'Generally negative', color: '#f87171' },
  liked: { text: 'Mostly liked', color: '#34d399' },
  mixed: { text: 'Mixed opinions', color: '#f59e0b' },
  criticized: { text: 'Often criticized', color: '#f87171' },
};

const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : 'n/a');
const tone100 = (tone: number | null) => (tone === null ? 'n/a' : String(Math.round(tone * 100)));

/** Positive / neutral / negative shares as one stacked bar. */
function MixBar({ positive, neutral, negative }: { positive: number; neutral: number; negative: number }) {
  const total = positive + neutral + negative;
  if (!total) return null;
  const part = (n: number) => `${(100 * n) / total}%`;
  return (
    <div className="mixbar" title={`${positive} positive · ${neutral} neutral · ${negative} negative`}>
      <span style={{ width: part(positive), background: '#34d399' }} />
      <span style={{ width: part(neutral), background: '#475569' }} />
      <span style={{ width: part(negative), background: '#f87171' }} />
    </div>
  );
}

function Verdict({ verdict, fallback }: { verdict: string | null; fallback: string }) {
  const spec = verdict ? VERDICTS[verdict] : null;
  return (
    <div className="verdict" style={{ color: spec?.color ?? '#64748b' }}>
      {spec?.text ?? fallback}
    </div>
  );
}

function Person({ data }: { data: PersonSentiment }) {
  const { own, received, stances } = data;
  return (
    <>
      <Verdict verdict={data.verdict} fallback="Too little judged writing for a verdict" />
      <div className="sent-row">
        <span>Their writing</span>
        <b style={{ color: toneColor(own.tone) }}>tone {tone100(own.tone)}</b>
        <span className="muted small">community {tone100(data.communityTone)} · 50 is neutral</span>
      </div>
      <MixBar {...own} />
      <div className="muted small">
        {own.items} judged posts and comments · {pct(own.hostile, own.items)} hostile
      </div>
      {Object.keys(stances).length > 0 && (
        <div className="chips sent-chips">
          {Object.entries(stances)
            .sort((a, b) => b[1] - a[1])
            .map(([stance, n]) => (
              <span
                key={stance}
                className="chip static"
                style={{ '--accent': STANCE_COLORS[stance] } as React.CSSProperties}
              >
                {stance.replace('_', ' ')} {n}
              </span>
            ))}
        </div>
      )}
      <div className="sent-row">
        <span>How others answer them</span>
        <b style={{ color: toneColor(received.tone) }}>tone {tone100(received.tone)}</b>
      </div>
      <MixBar {...received} />
      <div className="muted small">
        {received.items} replies and comments on their posts · {pct(received.disagreements, received.items)} disagree ·{' '}
        {pct(received.hostile, received.items)} hostile
      </div>
    </>
  );
}

function Business({ data }: { data: BusinessSentiment }) {
  const neutral = data.mentions - data.favorable - data.unfavorable;
  return (
    <>
      <Verdict verdict={data.verdict} fallback="Too few judged mentions for a verdict" />
      <MixBar positive={data.favorable} neutral={neutral} negative={data.unfavorable} />
      <div className="sent-row">
        <span>
          {data.favorable} favorable · {neutral} neutral · {data.unfavorable} unfavorable
        </span>
      </div>
      <div className="muted small">
        {data.mentions} mentions by {data.people} people · mean tone {tone100(data.tone)}
      </div>
      {data.judged < data.mentions && (
        <div className="muted small">
          {data.mentions - data.judged} mentions not yet judged for their opinion of this business; their overall tone
          stands in until they are assessed.
        </div>
      )}
    </>
  );
}

/** Overall sentiment of a person (how they write and are answered) or a business (how neighbors mention it). */
export function SentimentCard({ label, nodeKey }: { label: 'User' | 'Business'; nodeKey: string }) {
  const [data, setData] = useState<PersonSentiment | BusinessSentiment | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setData(null);
    setError(null);
    api
      .sentiment(label, nodeKey)
      .then((result) => !stale && setData(result))
      .catch((err) => !stale && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stale = true;
    };
  }, [label, nodeKey]);
  return (
    <div className="card">
      <div className="card-title">
        {label === 'User' ? 'Overall sentiment' : 'What neighbors think'}
        <span className="muted">AI assessment</span>
      </div>
      {error && <div className="error small">Could not load: {error}</div>}
      {!data && !error && <div className="spinner" />}
      {data?.kind === 'person' && <Person data={data} />}
      {data?.kind === 'business' && <Business data={data} />}
    </div>
  );
}
