export const getReleaseMetadata = (version, sourceDateEpoch) => {
  const fullVersion = typeof version === 'string' ? version.trim() : '';
  const epoch = typeof sourceDateEpoch === 'string' && /^\d+$/.test(sourceDateEpoch)
    ? Number(sourceDateEpoch)
    : NaN;
  const date = Number.isSafeInteger(epoch) && epoch > 0
    ? new Date(epoch * 1000)
    : null;
  const hasValidDate = date && !Number.isNaN(date.getTime());

  return {
    versionLabel: fullVersion ? `Release ${fullVersion.slice(0, 7)}` : 'Development build',
    date: hasValidDate ? date.toISOString().slice(0, 10) : null,
    dateLabel: hasValidDate
      ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
        year: 'numeric',
      }).format(date)
      : null,
  };
};

const releaseMetadata = getReleaseMetadata(
  process.env.REACT_APP_RELEASE_VERSION,
  process.env.REACT_APP_RELEASE_EPOCH,
);

export default releaseMetadata;
