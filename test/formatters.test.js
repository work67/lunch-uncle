import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CT_HUB_2,
  formatForecast,
  formatBusArrivals,
  formatPlaces,
  haversineMetres,
} from "../src/tools.js";

test("formatForecast picks the requested area", () => {
  const payload = {
    data: {
      items: [
        {
          valid_period: { text: "12 pm to 2 pm" },
          forecasts: [
            { area: "Geylang", forecast: "Fair" },
            { area: "Kallang", forecast: "Light Rain" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(formatForecast(payload, "Kallang"), {
    area: "Kallang",
    forecast: "Light Rain",
    valid_period: "12 pm to 2 pm",
  });
});

test("formatForecast returns an error when the area is missing", () => {
  const payload = {
    data: { items: [{ forecasts: [{ area: "Geylang", forecast: "Fair" }] }] },
  };

  assert.deepEqual(formatForecast(payload, "Kallang"), {
    error: "No forecast for Kallang right now",
  });
});

test("formatForecast flags a forecast whose period has ended", () => {
  const payload = {
    data: {
      items: [
        {
          valid_period: {
            start: "2026-10-21T10:00:00+08:00",
            end: "2026-10-21T12:00:00+08:00",
            text: "10.00 am to Midday",
          },
          forecasts: [{ area: "Kallang", forecast: "Fair" }],
        },
      ],
    },
  };

  const during = formatForecast(payload, "Kallang", new Date("2026-10-21T11:00:00+08:00"));
  const after = formatForecast(payload, "Kallang", new Date("2026-10-21T12:30:00+08:00"));

  assert.equal(during.stale, undefined);
  assert.equal(after.stale, true);
  assert.equal(after.forecast, "Fair");
});

test("formatBusArrivals converts durations to whole minutes", () => {
  const payload = {
    services: [
      {
        no: "13",
        next: { duration_ms: 100_798 },
        subsequent: { duration_ms: 1_210_000 },
      },
      { no: "107M", next: { duration_ms: 30_000 }, subsequent: null },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07369"), {
    stop_code: "07369",
    services: [
      { service: "13", next_min: 2, subsequent_min: 20 },
      { service: "107M", next_min: 1, subsequent_min: null },
    ],
  });
});

test("formatBusArrivals treats a bus that has left as no arrival", () => {
  const payload = {
    services: [
      {
        no: "13",
        next: { duration_ms: -90_000 },
        subsequent: { duration_ms: -20_000 },
      },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07369").services, [
    { service: "13", next_min: null, subsequent_min: 0 },
  ]);
});

test("formatBusArrivals keeps only the requested service", () => {
  const payload = {
    services: [
      { no: "13", next: { duration_ms: 60_000 } },
      { no: "107M", next: { duration_ms: 120_000 } },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07369", "107m").services, [
    { service: "107M", next_min: 2, subsequent_min: null },
  ]);
  assert.equal(
    formatBusArrivals(payload, "07369", "21").note,
    "No arrivals for bus 21 at this stop right now.",
  );
});

test("formatPlaces returns open_now, nearest first, within walking distance", () => {
  const places = [
    {
      displayName: { text: "Far" },
      location: { latitude: 1.3, longitude: 103.95 },
      currentOpeningHours: { openNow: true },
    },
    {
      displayName: { text: "Closed" },
      rating: 4.2,
      location: { latitude: 1.3125, longitude: 103.8635 },
      currentOpeningHours: { openNow: false },
    },
    {
      displayName: { text: "Near" },
      rating: 4.5,
      location: { latitude: 1.3116, longitude: 103.8634 },
    },
    { displayName: { text: "No location" } },
  ];

  assert.deepEqual(formatPlaces(places, CT_HUB_2), [
    { name: "Near", rating: 4.5, distance_m: 3, open_now: null },
    { name: "Closed", rating: 4.2, distance_m: 102, open_now: false },
  ]);
});

test("CT_HUB_2 is 400-550 m from Lavender MRT", () => {
  const lavenderMrt = { latitude: 1.3073, longitude: 103.8631 };
  const distance = haversineMetres(CT_HUB_2, lavenderMrt);
  assert.ok(distance > 400 && distance < 550, `got ${distance}`);
});
