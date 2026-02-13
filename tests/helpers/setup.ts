// Global test setup — set default env vars for test runs
process.env.NODE_ENV ??= "test";
process.env.AP_DOMAIN ??= "test.example.com";
process.env.FEDERATION_AUTH_TOKEN ??= "test-token";
