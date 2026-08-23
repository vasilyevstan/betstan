import { ConsumeMessage } from "amqplib";
import {
  AListener,
  IModerationResultEvent,
  ModerationStatus,
  QueueNames,
  SlipStatus,
} from "@betstan/common";
import { SlipArchive } from "../../model/Slip";
import {
  applyAffectedRows,
  clearSubmittedAttemptState,
  createSlipId,
  findArchivedSlipById,
  findDraftSlipBySourceSlipId,
  findSubmittedSlipById,
  isValidSlipId,
  normalizeBetKind,
  normalizePlainSlip,
  normalizeSlip,
  PlainSlip,
  toPlainSlip,
  upsertRestoredDraft,
} from "../../model/slipSupport";

const buildApprovedArchivePayload = (slip: Parameters<typeof toPlainSlip>[0]) => {
  const archivedSlip = toPlainSlip(slip);
  archivedSlip.status = SlipStatus.COMPLETE;

  return archivedSlip;
};

const buildDeclinedArchivePayload = (
  slip: Parameters<typeof toPlainSlip>[0],
  replacementSlipId: string | null,
  eventData: IModerationResultEvent["data"]
) => {
  const archivedSlip = toPlainSlip(slip);

  archivedSlip.replacementSlipId = replacementSlipId ?? undefined;
  archivedSlip.declineReason = eventData.declineReason;
  applyAffectedRows(archivedSlip, eventData.affectedRows ?? []);

  return archivedSlip;
};

const buildRestoredDraftPayload = (
  sourceSlip: PlainSlip,
  sourceSlipId: string,
  replacementSlipId: string,
  eventData: IModerationResultEvent["data"]
) => {
  const restoredDraft: PlainSlip = {
    ...sourceSlip,
    _id: replacementSlipId,
    status: SlipStatus.DRAFT,
    timestamp: new Date().toISOString(),
    submittedAt: undefined,
    sourceSlipId,
    replacementSlipId: undefined,
    declineReason: eventData.declineReason,
    rows: sourceSlip.rows.map((row) => ({ ...row })),
  };

  clearSubmittedAttemptState(restoredDraft);
  applyAffectedRows(restoredDraft, eventData.affectedRows ?? []);
  return normalizePlainSlip(restoredDraft, normalizeBetKind(sourceSlip.betKind));
};

const upsertArchivedSlip = async (payload: PlainSlip) => {
  await SlipArchive.updateOne(
    { _id: payload._id },
    { $set: payload },
    { upsert: true }
  );
};

class ModerationResultListener extends AListener<IModerationResultEvent> {
  serviceName: string = "slip_moderation_result";
  queue: QueueNames.MODERATION_RESULT = QueueNames.MODERATION_RESULT;

  async onMessage(event: IModerationResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    if (!isValidSlipId(data.slipId)) {
      this.ack(msg);
      return;
    }

    const betKind = normalizeBetKind(data.betKind);
    const [submittedSlip, archivedSlip, restoredDraft] = await Promise.all([
      findSubmittedSlipById(data.slipId, betKind),
      findArchivedSlipById(data.slipId, betKind),
      findDraftSlipBySourceSlipId(data.slipId),
    ]);

    if (data.result === ModerationStatus.APPROVED) {
      if (!submittedSlip) {
        if (archivedSlip) {
          this.ack(msg);
          return;
        }

        this.channel.nack(msg, undefined, true);
        return;
      }

      normalizeSlip(submittedSlip, betKind);
      await upsertArchivedSlip(buildApprovedArchivePayload(submittedSlip));
      await submittedSlip.deleteOne();
      this.ack(msg);
      return;
    }

    if (data.result === ModerationStatus.DECLINED) {
      const provisionalReplacementSlipId =
        archivedSlip?.replacementSlipId ?? restoredDraft?.id ?? createSlipId();

      if (submittedSlip) {
        normalizeSlip(submittedSlip, betKind);

        const restoredDraftPayload = buildRestoredDraftPayload(
          buildDeclinedArchivePayload(
            submittedSlip,
            provisionalReplacementSlipId,
            data
          ),
          data.slipId,
          provisionalReplacementSlipId,
          data
        );
        const mergedDraft = await upsertRestoredDraft(restoredDraftPayload);
        const mergedDraftId =
          typeof mergedDraft._id === "string"
            ? mergedDraft._id
            : mergedDraft._id?.toString() ?? null;
        const declinedArchivePayload = buildDeclinedArchivePayload(
          submittedSlip,
          mergedDraftId,
          data
        );

        await upsertArchivedSlip(declinedArchivePayload);
        await submittedSlip.deleteOne();
        this.ack(msg);
        return;
      }

      if (restoredDraft) {
        if (archivedSlip && archivedSlip.replacementSlipId !== restoredDraft.id) {
          await SlipArchive.updateOne(
            { _id: archivedSlip.id },
            { $set: { replacementSlipId: restoredDraft.id } }
          );
        }

        this.ack(msg);
        return;
      }

      if (!archivedSlip) {
        this.channel.nack(msg, undefined, true);
        return;
      }

      if (!archivedSlip.replacementSlipId) {
        this.ack(msg);
        return;
      }

      const restoredDraftPayload = buildRestoredDraftPayload(
        toPlainSlip(archivedSlip),
        data.slipId,
        archivedSlip.replacementSlipId,
        data
      );
      const mergedDraft = await upsertRestoredDraft(restoredDraftPayload);
      const mergedDraftId =
        typeof mergedDraft._id === "string"
          ? mergedDraft._id
          : mergedDraft._id?.toString() ?? null;

      if (mergedDraftId && mergedDraftId !== archivedSlip.replacementSlipId) {
        await SlipArchive.updateOne(
          { _id: archivedSlip.id },
          { $set: { replacementSlipId: mergedDraftId } }
        );
      }

      this.ack(msg);
      return;
    }

    this.ack(msg);
  }
}

export default ModerationResultListener;
