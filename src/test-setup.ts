import { vi } from "vitest";

vi.stubEnv("QUERY_DATABASE_URL", "postgresql://test:test@localhost:5432/test");
vi.stubEnv("WRITE_DATABASE_URL", "postgresql://test:test@localhost:5432/test");
vi.stubEnv("EXPECTED_DATABASE", "test");
vi.stubEnv("EXPECTED_READ_ROLE", "test_role");
vi.stubEnv("EXPECTED_WRITE_ROLE", "test_role");
vi.stubEnv("POOL_MAX_READ", "5");
vi.stubEnv("POOL_MAX_WRITE", "5");
vi.stubEnv("STATEMENT_TIMEOUT_MS", "10000");
vi.stubEnv("LOCK_TIMEOUT_MS", "5000");
vi.stubEnv("IDLE_IN_TRANSACTION_TIMEOUT_MS", "30000");