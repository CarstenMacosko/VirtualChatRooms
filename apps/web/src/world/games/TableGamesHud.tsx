import { ArrowLeft, Puzzle, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Table, TableGame } from "@vcr/protocol";
import type { TableGamesSync } from "../../lib/tableGames";
import { holderColor, playableTables, type TableGamesUi, useUi } from "./ui";

export interface TableGamesHudProps {
  tables: readonly Table[];
  sync: TableGamesSync;
  ui: TableGamesUi;
  selfId: string;
}

/**
 * The table games' DOM side: "Play puzzle" / "Start puzzle" when you're near a game table, the
 * start form, and the puzzle view's controls (Back, zoom, the game's own overlay).
 */
export function TableGamesHud(props: TableGamesHudProps) {
  return (
    <div className="table-games-hud" ref={keepFromWorld}>
      <HudContent {...props} />
    </div>
  );
}

/**
 * The World listens for drags on its whole area to look around; presses on these controls are
 * theirs alone (React's own stopPropagation runs too late for that native listener).
 */
function keepFromWorld(el: HTMLDivElement | null) {
  if (!el) return;
  const stop = (e: Event) => e.stopPropagation();
  el.addEventListener("pointerdown", stop);
  el.addEventListener("wheel", stop);
  return () => {
    el.removeEventListener("pointerdown", stop);
    el.removeEventListener("wheel", stop);
  };
}

function HudContent(props: TableGamesHudProps) {
  const { sync, ui } = props;
  useSyncExternalStore(sync.subscribe, sync.version);
  const near = useUi(ui, "near");
  const playing = useUi(ui, "playing");
  const starting = useUi(ui, "starting");
  const playable = useMemo(() => playableTables(props.tables), [props.tables]);
  const [confirmClear, setConfirmClear] = useState(false);

  const stop = useCallback(() => {
    ui.store.setState({ playing: null, starting: null });
    setConfirmClear(false);
  }, [ui]);
  useEffect(() => {
    if (!playing && !starting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (ui.store.getState().starting) ui.store.setState({ starting: null });
      else stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, starting, stop, ui]);

  const tableId = starting ?? playing ?? near;
  const table = playable.find((t) => t.id === tableId);
  if (!table || !props.selfId) return null;
  const synced = sync.table(table.id);
  const running = synced?.game === table.game && synced.setup ? synced : undefined;
  const { client } = table.module;
  const { Start, Hud } = table;

  if (starting === table.id) {
    return (
      <div className="table-start-backdrop">
        {running && <p className="hint">Starting a new one replaces the puzzle on the table.</p>}
        <Start
          table={table.frame}
          start={(options: unknown) => {
            sync.start(table.id, table.game as TableGame, table.frame.size, options);
            ui.store.setState({ starting: null, playing: table.id });
          }}
          cancel={() => ui.store.setState({ starting: null })}
        />
      </div>
    );
  }

  if (playing === table.id) {
    const holders = new Map<string, number>();
    for (const item of running?.items ?? []) {
      if (item.heldBy && item.heldBy !== props.selfId) {
        holders.set(item.heldBy, (holders.get(item.heldBy) ?? 0) + 1);
      }
    }
    return (
      <div className="table-play-hud">
        <button className="table-back" onClick={stop} aria-label="Back to the room">
          <ArrowLeft size={18} /> Back
        </button>
        <div className="table-zoom">
          <button className="secondary" aria-label="Zoom in" onClick={() => ui.focus.zoomBy(0.8)}>
            <ZoomIn size={18} />
          </button>
          <button className="secondary" aria-label="Zoom out" onClick={() => ui.focus.zoomBy(1.25)}>
            <ZoomOut size={18} />
          </button>
        </div>
        <div className="table-play-bottom">
          {running && Hud ? (
            <Hud
              table={table.frame}
              setup={running.setup}
              items={running.items}
              revision={running.revision}
              self={props.selfId}
              act={(action: unknown) => sync.act(table.id, action)}
              holder={() => null}
            />
          ) : (
            <p className="hint">No {client.noun} on this table yet.</p>
          )}
          <div className="row">
            <button
              className="secondary small"
              onClick={() => ui.store.setState({ starting: table.id })}
            >
              New {client.noun}
            </button>
            {running && (
              <button
                className={`small ${confirmClear ? "danger" : "secondary"}`}
                onClick={() => {
                  if (!confirmClear) return setConfirmClear(true);
                  sync.end(table.id);
                  setConfirmClear(false);
                }}
                onBlur={() => setConfirmClear(false)}
              >
                {confirmClear ? "Tap again to clear" : "Clear table"}
              </button>
            )}
          </div>
          {holders.size > 0 && (
            <p className="table-holders">
              {[...holders.keys()].map((id) => (
                <span key={id} className="holder-dot" style={{ background: holderColor(id) }} />
              ))}
              {holders.size === 1 ? "1 other person is" : `${holders.size} others are`} moving
              pieces
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="table-prompt">
      <Puzzle size={18} aria-hidden />
      <span className="table-prompt-text">
        {running ? client.status(running.setup, running.items) : `No ${client.noun} going yet`}
      </span>
      {running ? (
        <button onClick={() => ui.store.setState({ playing: table.id })}>Play {client.noun}</button>
      ) : (
        <button onClick={() => ui.store.setState({ starting: table.id })}>
          Start {client.noun}
        </button>
      )}
    </div>
  );
}
