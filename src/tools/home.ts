import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok, fail } from './types.js';
import type { Config } from '../config.js';

export function registerHomeTools(config: Config): ToolDef[] {
  const tools: ToolDef[] = [createWeatherTool()];

  if (config.ha) {
    tools.push(createHomeAssistantTool(config.ha.url, config.ha.token));
    tools.push(createTimerTool(config.ha.url, config.ha.token));
  }

  return tools;
}

function createWeatherTool(): ToolDef {
  return {
    name: 'weather',
    description: 'Get current weather and forecast for any location. Uses Open-Meteo (free, no API key needed).',
    schema: z.object({
      action: z.enum(['current', 'forecast']).describe('Get current weather or multi-day forecast'),
      location: z.string().describe('City name or coordinates (e.g. "San Francisco" or "37.7749,-122.4194")'),
      days: z.number().optional().describe('Number of forecast days (default 3, max 7)'),
    }),
    execute: async (params) => {
      try {
        const location = params.location as string;
        const action = params.action as string;
        const days = Math.min((params.days as number) || 3, 7);

        // Geocode the location
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
        const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(10000) });
        const geoData = await geoRes.json() as { results?: Array<{ latitude: number; longitude: number; name: string; country: string }> };

        if (!geoData.results || geoData.results.length === 0) {
          return fail(`Location not found: ${location}`);
        }

        const { latitude, longitude, name, country } = geoData.results[0];

        if (action === 'current') {
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
          const data = await res.json() as { current: Record<string, number> };
          const c = data.current;

          return ok(
            `Weather in ${name}, ${country}:\n` +
            `  Temperature: ${c.temperature_2m}°F (feels like ${c.apparent_temperature}°F)\n` +
            `  Humidity: ${c.relative_humidity_2m}%\n` +
            `  Wind: ${c.wind_speed_10m} mph\n` +
            `  Precipitation: ${c.precipitation} mm`
          );
        } else {
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&temperature_unit=fahrenheit&forecast_days=${days}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
          const data = await res.json() as { daily: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_sum: number[] } };
          const d = data.daily;

          const lines = [`${days}-day forecast for ${name}, ${country}:`];
          for (let i = 0; i < d.time.length; i++) {
            lines.push(`  ${d.time[i]}: ${d.temperature_2m_min[i]}°F - ${d.temperature_2m_max[i]}°F, precip: ${d.precipitation_sum[i]}mm`);
          }

          return ok(lines.join('\n'));
        }
      } catch (err) {
        return fail(`Weather failed: ${(err as Error).message}`);
      }
    },
  };
}

function createHomeAssistantTool(haUrl: string, haToken: string): ToolDef {
  return {
    name: 'home_assistant',
    description: 'Control Home Assistant smart home devices. Turn lights on/off, check sensors, run automations, get entity states.',
    schema: z.object({
      action: z.enum(['get_states', 'get_state', 'call_service', 'toggle', 'turn_on', 'turn_off']).describe('Action to perform'),
      entity_id: z.string().optional().describe('Entity ID (e.g. "light.living_room", "switch.fan")'),
      domain: z.string().optional().describe('Service domain for call_service (e.g. "light", "switch", "automation")'),
      service: z.string().optional().describe('Service name for call_service (e.g. "toggle", "turn_on")'),
      data: z.string().optional().describe('Service data as JSON string'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;
        const headers = {
          'Authorization': `Bearer ${haToken}`,
          'Content-Type': 'application/json',
        };

        switch (action) {
          case 'get_states': {
            const res = await fetch(`${haUrl}/api/states`, { headers, signal: AbortSignal.timeout(10000) });
            const states = await res.json() as Array<{ entity_id: string; state: string; attributes: { friendly_name?: string } }>;
            const summary = states
              .slice(0, 50)
              .map(s => `${s.attributes.friendly_name || s.entity_id}: ${s.state}`)
              .join('\n');
            return ok(`${states.length} entities:\n${summary}\n... (showing first 50)`);
          }

          case 'get_state': {
            const entityId = params.entity_id as string;
            if (!entityId) return fail('entity_id is required');
            const res = await fetch(`${haUrl}/api/states/${entityId}`, { headers, signal: AbortSignal.timeout(10000) });
            if (!res.ok) return fail(`Entity not found: ${entityId}`);
            const state = await res.json();
            return ok(JSON.stringify(state, null, 2));
          }

          case 'turn_on':
          case 'turn_off':
          case 'toggle': {
            const entityId = params.entity_id as string;
            if (!entityId) return fail('entity_id is required');
            const domain = entityId.split('.')[0];
            const res = await fetch(`${haUrl}/api/services/${domain}/${action}`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ entity_id: entityId }),
              signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) return fail(`Service call failed: ${res.status}`);
            return ok(`${action} → ${entityId}`);
          }

          case 'call_service': {
            const domain = params.domain as string;
            const service = params.service as string;
            if (!domain || !service) return fail('domain and service are required');
            let data = {};
            if (params.data) {
              try { data = JSON.parse(params.data as string); } catch { return fail('Invalid data JSON'); }
            }
            if (params.entity_id) {
              (data as Record<string, unknown>).entity_id = params.entity_id;
            }
            const res = await fetch(`${haUrl}/api/services/${domain}/${service}`, {
              method: 'POST',
              headers,
              body: JSON.stringify(data),
              signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) return fail(`Service call failed: ${res.status}`);
            return ok(`Called ${domain}.${service}`);
          }
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Home Assistant failed: ${(err as Error).message}`);
      }
    },
  };
}

function createTimerTool(haUrl: string, haToken: string): ToolDef {
  return {
    name: 'timer',
    description: 'Set a timer with optional announcement via Home Assistant TTS when it completes.',
    schema: z.object({
      action: z.enum(['set', 'list', 'cancel']).describe('Timer action'),
      name: z.string().optional().describe('Timer name/label'),
      seconds: z.number().optional().describe('Timer duration in seconds'),
      message: z.string().optional().describe('TTS message when timer completes'),
    }),
    execute: async (params) => {
      const action = params.action as string;

      if (action === 'set') {
        const seconds = params.seconds as number;
        if (!seconds) return fail('seconds is required for set action');

        const name = (params.name as string) || 'Timer';
        const message = (params.message as string) || `${name} is done`;

        // Use setTimeout for in-process timer
        setTimeout(async () => {
          try {
            // TTS announcement via HA
            await fetch(`${haUrl}/api/services/tts/speak`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${haToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                entity_id: 'tts.piper',
                message,
              }),
            });
          } catch {
            // Timer still fires even if TTS fails
          }
          console.log(`\n⏰ Timer "${name}" completed: ${message}`);
        }, seconds * 1000);

        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        return ok(`Timer "${name}" set for ${timeStr}`);
      }

      if (action === 'cancel') {
        return ok('Timer cancellation not yet implemented for in-process timers');
      }

      return ok('Timer listing not yet implemented');
    },
  };
}
