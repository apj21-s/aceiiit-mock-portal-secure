const { EventEmitter } = require("events");

// In-process domain events. Lets core flows (e.g. exam finalization) announce facts without
// importing the modules that react to them, so exam-integrity code never depends on the AI
// layer. Listeners must not throw back into the emitter.
const domainEvents = new EventEmitter();
domainEvents.setMaxListeners(20);

module.exports = { domainEvents, EVENTS: { ATTEMPT_FINALIZED: "attempt.finalized" } };
