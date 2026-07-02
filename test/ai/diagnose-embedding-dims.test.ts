/**
 * diagnoseEmbedding dims-presence guard (#1292 / eng-review D6).
 *
 * The old `user_provided_model_unset` guard fired for ANY litellm config with an
 * empty recipe model-allowlist — including a fully-specified `litellm:bge-large`
 * with dims set — so vector search was silently disabled ("No results."). It was
 * also structurally unreachable as a "no model" check (parseModelId throws on a
 * bare provider). It's replaced with a real dimensions-presence check: a
 * user-provided / zero-default recipe with no explicit embedding_dimensions fails
 * CLOSED here with a clear reason, instead of returning ok and failing with a
 * cryptic wrong-width error at embed time.
 *
 * No embed transport is installed (resetGateway clears it) so diagnoseEmbedding
 * runs its real config-only logic rather than the test fast-path.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { configureGateway, diagnoseEmbedding, resetGateway } from '../../src/core/ai/gateway.ts';

afterEach(() => resetGateway());

describe('diagnoseEmbedding dims-presence guard (#1292/D6)', () => {
  test('litellm:<model> WITH embedding_dimensions → available (the #1292 false-positive is gone)', () => {
    configureGateway({
      embedding_model: 'litellm:bge-large',
      embedding_dimensions: 1024,
      env: {},
    });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(true);
  });

  test('litellm:<model> WITHOUT embedding_dimensions → fails closed with user_provided_dims_unset', () => {
    configureGateway({
      embedding_model: 'litellm:bge-large',
      // no embedding_dimensions on purpose
      env: {},
    });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('user_provided_dims_unset');
  });

  test('a fixed-dim provider with its own default_dims needs no explicit dimension', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(true);
  });
});
