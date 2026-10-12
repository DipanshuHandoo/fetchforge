export const input = {
  endpoints: [
    // { name: 'health', url: 'https://api.example.com/health', expectedStatuses: [200] },
  ],
  intervalMs: 60_000,
  windowMs: 300_000,
  maxSamples: 1000,
  availabilityTarget: 99,
  latencyTarget: 95,
  maxLatencyMs: 1000,
  timeout: 5000,
  webhook: process.env.UPTIME_WEBHOOK_URL ?? '',
};
