<script lang="ts">
  import type { PendingConfirmation } from "@nova/contracts";
  import { confirmAction } from "#lib/api/admin.ts";
  import Button from "#components/ui/Button.svelte";
  import { sessionId } from "./session.ts";

  let {
    action,
    onreply,
  }: { action: PendingConfirmation; onreply?: (reply: string) => void } =
    $props();

  type Values = {
    temperature?: number;
    volume_level?: number;
    group_members?: string[];
    message?: string;
    text?: string;
    media_id?: string;
    media_content_id?: string;
    service?: string;
    entity_id?: string;
    entity_ids?: string[];
    vmid?: number | string;
    id?: number | string;
  };

  const initial = (): string => {
    const args = action.args as Values & { data?: Values };
    const values = { ...args, ...args.data };
    const changes = [
      values.temperature !== undefined ? `${values.temperature} °C` : null,
      values.volume_level !== undefined
        ? `${Math.round(values.volume_level * 100)}% volume`
        : null,
      values.group_members?.join(", "),
      values.message ||
        values.text ||
        values.media_id ||
        values.media_content_id,
    ]
      .filter(Boolean)
      .join("; ");
    return `${args.service || action.tool.replaceAll("_", " ")}: ${args.entity_id || args.entity_ids?.join(", ") || args.vmid || args.id || ""}${changes ? "; " + changes : ""}. Bevestiging verloopt na 60 seconden.`;
  };

  let label = $state(initial());
  let locked = $state(false);

  $effect(() => {
    const timer = setTimeout(
      () => (locked = true),
      Math.max(0, action.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  });

  async function answer(approve: boolean): Promise<void> {
    locked = true;
    try {
      const data = await confirmAction(
        sessionId(),
        action.confirmationId,
        approve,
      );
      label = data.reply;
      onreply?.(data.reply);
    } catch (error) {
      label = error instanceof Error ? error.message : "Bevestiging mislukt";
    }
  }
</script>

<div class="confirmation-controls">
  <span>{label}</span>
  <Button disabled={locked} onclick={() => answer(true)}>Bevestigen</Button>
  <Button disabled={locked} onclick={() => answer(false)}>Annuleren</Button>
</div>
