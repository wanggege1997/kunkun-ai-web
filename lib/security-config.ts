export const SECURITY_POLICY = {
  auth: {
    login: {
      limit: 10,
      windowSec: 5 * 60,
    },
    register: {
      limit: 6,
      windowSec: 5 * 60,
    },
  },
  queue: {
    enqueue: {
      limit: 20,
      windowSec: 60,
    },
  },
  cooldown: {
    usernameUpdateSec: 30,
    passwordUpdateSec: 30,
  },
} as const;
