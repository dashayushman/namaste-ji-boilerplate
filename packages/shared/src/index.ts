// Common types and schemas will go here
export interface PingResponse {
  message: string;
  timestamp: string;
}

// The Content Brief contract (Creative Head → Content-Gen agent) — versioned single source of truth.
export * from './brief';

// The Content Production contracts (shot · asset · batch record) — Director → Creator → Heimdall.
export * from './content';

// The Feed Event taxonomy (impression/dwell/skip/open/share_intent) — one contract for Lab sim + app.
export * from './feed-events';

// The Onboarding Signals contract — real onboarding + Lab persona builder (FL-10).
export * from './onboarding';

// The consumer feed serving contract (playlist page · tabs · profile) — consumer-api → app.
export * from './playlist';

// The temple live-darshan contract (temple · stream · saved-state) — BO author, consumer reader.
export * from './temple';
