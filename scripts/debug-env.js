require('dotenv').config();

const keys = ['ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID',
  'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'OUTLOOK_TENANT_ID', 'OUTLOOK_REFRESH_TOKEN',
  'TIMEZONE', 'DATABASE_PATH', 'LOG_LEVEL'];

for (const k of keys) {
  const v = process.env[k];
  if (v) {
    console.log(k + '=' + v.substring(0, 15) + '...' + ' (length: ' + v.length + ')');
  } else {
    console.log(k + '= *** MISSING ***');
  }
}
