/**
 * The calendar day (YYYY-MM-DD) of a timestamp in the viewer's time zone. A bare date, such as a week's
 * Monday the server already bucketed, is a calendar label and passes through unchanged.
 */
export const day = (value: unknown) => {
  if (typeof value !== 'string') return '';
  const at = new Date(value);
  if (!value.includes('T') || Number.isNaN(at.getTime())) return value.slice(0, 10);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};
