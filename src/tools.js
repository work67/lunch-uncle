/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

// CT Hub 2, 114 Lavender Street (OneMap geocode for postcode 338729).
export const CT_HUB_2 = { latitude: 1.311588, longitude: 103.863375 };

// Bus stops within a short walk of CT Hub 2, nearest first (busrouter.sg stop data).
export const NEARBY_BUS_STOPS = [
  { code: "07369", name: "Aft Kallang Bahru", distance_m: 112 },
  { code: "07379", name: "Aperia/Bef Kallang Rd", distance_m: 158 },
  { code: "07361", name: "Bef Kallang Bahru", distance_m: 165 },
];

const SEARCH_RADIUS_METRES = 800;
// The search radius is only a bias, so results further than this are dropped.
export const MAX_WALK_METRES = 1000;
const MAX_PLACES = 10;
const FORECAST_AREA = "Kallang";
const DEFAULT_STOP_CODE = NEARBY_BUS_STOPS[0].code;

const TOOL_TIMEOUT_MS = 8_000;
const PLACES_CACHE_MS = 10 * 60_000;
const FORECAST_CACHE_MS = 5 * 60_000;
// arrivelah reports a bus at the stop as slightly negative; past this it has left.
const DEPARTED_MS = -60_000;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        "Search for places to eat within walking distance of CT Hub 2, nearest first. Returns name, rating, distance in metres, and open_now (true, false, or null if unknown).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "chicken rice", "japanese", "cheap lunch".',
          },
          open_now: {
            type: "boolean",
            description: "Only return places that are open right now.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the two-hour weather forecast for the Kallang area, which covers CT Hub 2.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_arrivals",
      description: `Get the next bus arrivals at a Singapore bus stop. Defaults to ${DEFAULT_STOP_CODE} (${NEARBY_BUS_STOPS[0].name}), the stop nearest CT Hub 2.`,
      parameters: {
        type: "object",
        properties: {
          stop_code: {
            type: "string",
            description: `Five-digit bus stop code, e.g. "${DEFAULT_STOP_CODE}". Leave out to use the stop nearest CT Hub 2.`,
          },
          service: {
            type: "string",
            description: 'Only return this bus service, e.g. "13".',
          },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one tool call requested by the model and return the result as a string.
 * Failures come back as {error} so the model can still answer.
 */
export async function executeTool(name, args, env) {
  try {
    return JSON.stringify(await runTool(name, args, env));
  } catch (err) {
    console.error(`tool ${name} failed:`, err);
    const reason = err?.name === "TimeoutError" ? "timed out" : err?.message;
    return JSON.stringify({ error: `${name} failed: ${reason}` });
  }
}

function runTool(name, args, env) {
  switch (name) {
    case "find_lunch_places":
      return findLunchPlaces(args, env);
    case "get_rain_forecast":
      return getRainForecast();
    case "get_bus_arrivals":
      return getBusArrivals(args);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  }
  return res.json();
}

// Results shared across requests in the same isolate, so repeat questions
// skip the paid Places call and the forecast fetch.
const cache = new Map();
const MAX_CACHE_ENTRIES = 100;

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  const value = await load();
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

async function findLunchPlaces({ query, open_now = false }, env) {
  if (typeof query !== "string" || query.trim() === "") {
    return { error: "query is required" };
  }
  if (!env.GOOGLE_PLACES_API_KEY) {
    console.warn("GOOGLE_PLACES_API_KEY is not set");
    return { error: "Places search is not set up, cannot look up places" };
  }

  const textQuery = query.trim();
  const openNow = open_now === true;
  const key = `places:${openNow}:${textQuery.toLowerCase()}`;

  return cached(key, PLACES_CACHE_MS, async () => {
    const data = await fetchJson(PLACES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask":
          "places.displayName,places.location,places.rating,places.currentOpeningHours",
      },
      body: JSON.stringify({
        textQuery,
        openNow,
        pageSize: MAX_PLACES,
        locationBias: {
          circle: { center: CT_HUB_2, radius: SEARCH_RADIUS_METRES },
        },
      }),
    });

    const places = formatPlaces(data.places ?? [], CT_HUB_2);
    if (places.length === 0) {
      return { places, note: "Nothing within walking distance for that search." };
    }
    return { places };
  });
}

/**
 * Shape Places API results into the fields Uncle needs, nearest first,
 * dropping places without a location or beyond walking distance.
 */
export function formatPlaces(places, origin, maxMetres = MAX_WALK_METRES) {
  return places
    .filter(
      ({ location }) =>
        Number.isFinite(location?.latitude) &&
        Number.isFinite(location?.longitude),
    )
    .map(({ displayName, rating, location, currentOpeningHours }) => ({
      name: displayName?.text ?? "Unnamed",
      rating: rating ?? null,
      distance_m: Math.round(haversineMetres(origin, location)),
      open_now: currentOpeningHours?.openNow ?? null,
    }))
    .filter((place) => place.distance_m <= maxMetres)
    .sort((a, b) => a.distance_m - b.distance_m);
}

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

async function getRainForecast() {
  const payload = await cached("forecast", FORECAST_CACHE_MS, () =>
    fetchJson(FORECAST_URL),
  );
  return formatForecast(payload, FORECAST_AREA, new Date());
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload,
 * flagging it if its period has already ended.
 */
export function formatForecast(payload, area, now = new Date()) {
  const item = payload?.data?.items?.[0];
  if (!item) {
    return { error: "No forecast available" };
  }
  const wanted = area.toLowerCase();
  const entry = item.forecasts?.find((f) => f.area?.toLowerCase() === wanted);
  if (!entry) {
    return { error: `No forecast for ${area} right now` };
  }

  const result = {
    area,
    forecast: entry.forecast,
    valid_period: item.valid_period?.text ?? null,
  };
  const end = Date.parse(item.valid_period?.end);
  if (Number.isFinite(end) && end < now.getTime()) {
    return {
      ...result,
      stale: true,
      note: "This forecast period has already ended, so treat it as a rough guide.",
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

async function getBusArrivals({ stop_code, service }) {
  const stopCode = stop_code ? String(stop_code).trim() : DEFAULT_STOP_CODE;
  if (!/^\d{5}$/.test(stopCode)) {
    return { error: "stop_code must be a five-digit bus stop code" };
  }
  const payload = await fetchJson(`${BUS_URL}?id=${stopCode}`);
  return formatBusArrivals(payload, stopCode, service);
}

/**
 * Reduce an arrivelah response to service numbers and minutes to arrival,
 * optionally keeping only one service.
 */
export function formatBusArrivals(payload, stopCode, service) {
  const wanted = service ? String(service).trim().toUpperCase() : null;
  const services = (payload?.services ?? []).filter(
    (s) => !wanted || String(s.no).toUpperCase() === wanted,
  );

  const result = {
    stop_code: stopCode,
    services: services.map((s) => ({
      service: s.no,
      next_min: minutesFromNow(s.next),
      subsequent_min: minutesFromNow(s.subsequent),
    })),
  };
  if (wanted && services.length === 0) {
    result.note = `No arrivals for bus ${wanted} at this stop right now.`;
  }
  return result;
}

function minutesFromNow(arrival) {
  if (arrival?.duration_ms == null) {
    return null;
  }
  const ms = Number(arrival.duration_ms);
  if (!Number.isFinite(ms) || ms < DEPARTED_MS) {
    return null;
  }
  return Math.max(0, Math.round(ms / 60000));
}
