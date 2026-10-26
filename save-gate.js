export function createSaveGate() {
  let inFlight = false;
  return {
    tryBegin() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    end() {
      inFlight = false;
    },
    get pending() {
      return inFlight;
    },
  };
}

if (typeof window !== "undefined") {
  window.SaveGate = { createSaveGate };
}
