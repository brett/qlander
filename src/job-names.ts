// The tick jobs' names in tick.yml; each lease records its job so a successor
// can ask GitHub whether it finished. In their own module so the watchdog can
// use them without importing the tick (and its config load).
export const QUEUE_JOB_NAME = "Queue tick";
export const RELEASE_JOB_NAME = "Release advance";

/**
 * The control repo's branch the tick workflow runs from: the only ref the
 * self-chaining dispatch names, and the only branch whose runs the watchdog
 * counts as ticks. Fixed until the workflows are rendered from config.
 */
export const CONTROL_BRANCH = "main";
