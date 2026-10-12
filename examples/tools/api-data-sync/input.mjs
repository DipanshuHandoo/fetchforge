export const input = {
  jobId: 'contacts-v1',
  sourceUrl: '',
  destinationUrl: '',
  sourcePath: '/records',
  destinationPath: '/contacts',
  pageSize: 100,
  concurrency: 5,
  maxPages: 1000,
  timeout: 5000,
  requestsPerSecond: 10,
  recordId: (record) => String(record.id),
  transform: (record) => ({ externalId: record.id, name: record.name, email: record.email }),
  sourceAuth: {
    token: process.env.SYNC_SOURCE_TOKEN,
    refreshUrl: process.env.SYNC_SOURCE_REFRESH_URL,
    refreshToken: process.env.SYNC_SOURCE_REFRESH_TOKEN,
  },
  destinationAuth: {
    token: process.env.SYNC_DESTINATION_TOKEN,
    refreshUrl: process.env.SYNC_DESTINATION_REFRESH_URL,
    refreshToken: process.env.SYNC_DESTINATION_REFRESH_TOKEN,
  },
};
