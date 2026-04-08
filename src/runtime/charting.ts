import type { PluginInput } from "../common/common.ts";
import type { EngramConfig } from "../common/config.ts";
import type { BrowseOutput, OverviewOutput } from "../domain/types.ts";

import { createBrowseContext, resolveSessionTarget } from "../core/index.ts";
import { createHistoryBackend } from "./backends/index.ts";
import { log } from "./logger.ts";
import { browseData, loadOverviewState } from "./runtime.ts";

export interface ChartingData {
  overview: OverviewOutput;
  latestTurnDetail: BrowseOutput;
}

// =============================================================================
// Output Assembly Helpers
// =============================================================================

function emptyLatestTurnDetail(): BrowseOutput {
  return {
    before_message_id: null,
    messages: [],
    after_message_id: null,
  };
}

// =============================================================================
// Charting Data Loading
// =============================================================================

/**
 * Load the structured data used to assemble the chart block for the current session.
 */
export async function loadChartingData(
  input: PluginInput,
  sessionID: string,
  config: EngramConfig,
): Promise<ChartingData> {
  const journal = log(input.client, sessionID);
  const backend = createHistoryBackend(input);
  const target = await resolveSessionTarget(backend, sessionID);
  const overviewBrowse = createBrowseContext(target, true, backend);
  const overviewState = await loadOverviewState(input, overviewBrowse, config, journal);
  const latestTurn = overviewState.turns.at(-1);
  const minTurn = latestTurn
    ? latestTurn.turn - config.context_charting.recent_turns
    : Number.POSITIVE_INFINITY;
  const overview: OverviewOutput = {
    turns: overviewState.turns
      .filter((turn) => turn.turn >= minTurn)
      .map((turn) => turn.output),
  };

  if (!latestTurn) {
    return {
      overview,
      latestTurnDetail: emptyLatestTurnDetail(),
    };
  }

  return {
    overview,
    latestTurnDetail: await browseData(
      input,
      createBrowseContext(target, false, backend),
      config,
      journal,
      {
        messageID: latestTurn.lastVisibleMessageId,
        numBefore: config.context_charting.recent_messages,
        numAfter: 0,
      },
    ),
  };
}
