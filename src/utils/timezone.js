/** India-only app timezone (IST, no DST). */
const APP_TIMEZONE = 'Asia/Kolkata';
const APP_UTC_OFFSET = '+05:30';

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Format a Date (or now) as MySQL DATETIME in Asia/Kolkata. */
function formatMysqlDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function addMinutesMysql(minutes, from = new Date()) {
  return formatMysqlDateTime(new Date(from.getTime() + Number(minutes) * 60 * 1000));
}

function addDaysMysql(days, from = new Date()) {
  return formatMysqlDateTime(new Date(from.getTime() + Number(days) * 24 * 60 * 1000));
}

module.exports = {
  APP_TIMEZONE,
  APP_UTC_OFFSET,
  formatMysqlDateTime,
  addMinutesMysql,
  addDaysMysql,
};
