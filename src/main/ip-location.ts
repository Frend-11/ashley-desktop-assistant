import type { WeatherCoordinates } from './weather';

// City-level fallback location for weather when the platform has no usable
// device location API (or the user denied it). Shared by the Linux and
// Windows builds.
export async function resolveCoarseLocationByIp(): Promise<WeatherCoordinates | null> {
  try {
    const response = await fetch('https://ipwho.is/', {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { success?: unknown; latitude?: unknown; longitude?: unknown };
    if (payload.success !== true) return null;
    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}
