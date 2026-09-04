import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import Slip from './Slip';
import { BET_KIND, BET_STATUS } from '../liveBettingUtils';
import { POLL_INTERVAL_MS, REFRESH_DELAY_MS, SLIP_STATUS } from '../hook/useSlipBoards';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const createDeferred = () => {
  let resolve;
  let reject;

  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
};

const buildModeration = (rowId) => ({
  rowId,
  declineReason: 'STALE_QUOTE',
  quoteVersion: 2,
  currentOdds: 2.1,
  marketStatus: 'OPEN',
});

const buildRow = ({
  betKind = BET_KIND.PRE_MATCH,
  oddsName = 'Team A',
  oddsValue = 1.5,
  marketVersion = 1,
  quoteVersion = 1,
  selectionId = 'selection-home',
  moderation,
} = {}) => ({
  _id: `${betKind}-${oddsName}-${quoteVersion}`,
  eventId: `${betKind}-event-1`,
  eventName: betKind === BET_KIND.LIVE ? 'Live Derby' : 'Pre-match Clash',
  oddsId: betKind === BET_KIND.LIVE ? `market-1:${selectionId}` : 'odds-home',
  oddsValue,
  oddsName,
  productName: betKind === BET_KIND.LIVE ? 'Next Corner' : '1X2',
  productId: betKind === BET_KIND.LIVE ? 'market-1' : 'product-1',
  timestamp: '2030-01-01T12:00:00.000Z',
  eventTime: '2030-01-01T12:00:00.000Z',
  betKind,
  marketId: betKind === BET_KIND.LIVE ? 'market-1' : undefined,
  marketType: betKind === BET_KIND.LIVE ? 'NEXT_CORNER' : undefined,
  marketVersion: betKind === BET_KIND.LIVE ? marketVersion : undefined,
  quoteVersion: betKind === BET_KIND.LIVE ? quoteVersion : undefined,
  selectionId: betKind === BET_KIND.LIVE ? selectionId : undefined,
  side: betKind === BET_KIND.LIVE ? 'HOME' : undefined,
  moderation,
});

const buildBoard = (betKind, overrides = {}) => {
  const boardId = overrides._id ?? `${betKind}-slip-1`;
  const boardRevision = overrides.boardRevision ?? 1;
  const boardFingerprint = overrides.boardFingerprint ?? `${boardId}-fingerprint-${boardRevision}`;

  return {
    _id: boardId,
    betKind,
    status: SLIP_STATUS.DRAFT,
    timestamp: '2030-01-01T12:00:00.000Z',
    boardRevision,
    boardFingerprint,
    rows: [buildRow({ betKind })],
    ...overrides,
  };
};

const getBoardsPayload = (overrides = {}) => ({
  [BET_KIND.PRE_MATCH]: buildBoard(BET_KIND.PRE_MATCH),
  [BET_KIND.LIVE]: buildBoard(BET_KIND.LIVE, {
    rows: [buildRow({ betKind: BET_KIND.LIVE, oddsName: 'Home', oddsValue: 1.8, selectionId: 'home', quoteVersion: 1 })],
  }),
  ...overrides,
});

const getSubmittedBoard = (betKind, overrides = {}) => buildBoard(betKind, {
  _id: `${betKind.toLowerCase()}-submitted-1`,
  status: SLIP_STATUS.SUBMITTED,
  ...overrides,
});

const buildBoardConfirmation = ({
  slipId,
  boardRevision = 1,
  boardFingerprint = `${slipId}-fingerprint-${boardRevision}`,
}) => ({
  expectedBoardRevision: boardRevision,
  expectedBoardFingerprint: boardFingerprint,
});

const buildPlacementRequest = ({
  betKind,
  slipId,
  wager,
  placementAttemptId,
  boardRevision = 1,
  boardFingerprint = `${slipId}-fingerprint-${boardRevision}`,
}) => ({
  betKind,
  slipId,
  wager,
  placementAttemptId,
  ...buildBoardConfirmation({
    slipId,
    boardRevision,
    boardFingerprint,
  }),
});

const getRequestCount = (url) => axios.get.mock.calls.filter(([requestUrl]) => requestUrl === url).length;

const advanceTime = async (timeMs) => {
  await act(async () => {
    jest.advanceTimersByTime(timeMs);
  });
};

const flushAsync = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const setWindowCrypto = (cryptoValue) => {
  Object.defineProperty(window, 'crypto', {
    configurable: true,
    value: cryptoValue,
  });
};

const createFallbackCrypto = (bytes) => ({
  getRandomValues: jest.fn((array) => {
    array.set(bytes);
    return array;
  }),
});

const buildAxiosError = ({ message = 'Request failed', status, data } = {}) => {
  const error = new Error(message);

  if (status) {
    error.response = {
      status,
      data: data ?? {},
    };
    return error;
  }

  error.request = {};
  return error;
};

const createSubmittedBoard = (betKind, overrides = {}) => getSubmittedBoard(betKind, {
  ...overrides,
  submittedEvent: {
    wager: 5,
    betKind,
    ...overrides.submittedEvent,
  },
});

describe('Slip', () => {
  let boardsResponse;
  let betsResponse;
  let betsImplementation;
  let originalCrypto;
  let randomUUIDMock;

  const renderSlip = async (props = {}) => {
    let renderResult;
    await act(async () => {
      renderResult = render(
        <Slip
          currentUser={{ id: 'user-1' }}
          onBoardSubmitted={jest.fn()}
          onSelectionKeysChange={jest.fn()}
          refreshSignal={0}
          uiVariant="v2"
          {...props}
        />,
      );
    });

    return renderResult;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    boardsResponse = getBoardsPayload();
    betsResponse = [];
    betsImplementation = null;
    originalCrypto = window.crypto;
    let nextAttemptIndex = 0;
    randomUUIDMock = jest.fn(() => `placement-attempt-${nextAttemptIndex += 1}`);
    setWindowCrypto({
      ...(originalCrypto ?? {}),
      randomUUID: randomUUIDMock,
    });

    axios.get.mockReset();
    axios.post.mockReset();
    axios.get.mockImplementation((url) => {
      if (url === '/api/slip/boards') {
        return Promise.resolve({ data: boardsResponse });
      }

      if (url === '/api/bet') {
        if (betsImplementation) {
          return betsImplementation();
        }

        return Promise.resolve({ data: betsResponse });
      }

      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
    axios.post.mockImplementation((url) => {
      if (url === '/api/slip/bet') {
        return Promise.resolve({ data: {} });
      }

      return Promise.resolve({ data: {} });
    });
  });

  afterEach(() => {
    setWindowCrypto(originalCrypto);
    jest.useRealTimers();
  });

  it('switches a board into authoritative submitted state on refresh and disables editing', async () => {
    const { rerender } = await renderSlip();

    await screen.findByLabelText('Wager for LIVE SLIP');
    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');

    expect(within(liveSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();
    expect(getRequestCount('/api/bet')).toBe(0);

    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, {
        _id: 'live-submitted-1',
        rows: [buildRow({ betKind: BET_KIND.LIVE, oddsName: 'Home', oddsValue: 1.8, selectionId: 'home', quoteVersion: 1 })],
      }),
    });
    betsResponse = [{ slipId: 'live-submitted-1', status: BET_STATUS.PENDING }];

    rerender(
      <Slip
        currentUser={{ id: 'user-1' }}
        onBoardSubmitted={jest.fn()}
        onSelectionKeysChange={jest.fn()}
        refreshSignal={1}
        uiVariant="v2"
      />,
    );

    await advanceTime(REFRESH_DELAY_MS);

    await waitFor(() => expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled());
    expect(within(liveSection()).getByText('Awaiting live moderation and approval…')).toBeInTheDocument();
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeDisabled();
    expect(getRequestCount('/api/bet')).toBe(1);
  });

  it('applies authoritative submitted boards and keeps polling when history enrichment rejects', async () => {
    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, { _id: 'live-submitted-1' }),
    });
    betsImplementation = () => Promise.reject(new Error('history unavailable'));

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    await screen.findByText('Awaiting live moderation and approval…');

    expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeDisabled();
    expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled();
    expect(getRequestCount('/api/slip/boards')).toBe(1);
    expect(getRequestCount('/api/bet')).toBe(1);

    await advanceTime(POLL_INTERVAL_MS);
    await waitFor(() => expect(getRequestCount('/api/slip/boards')).toBeGreaterThanOrEqual(2));
    expect(getRequestCount('/api/bet')).toBeGreaterThanOrEqual(2);
    expect(within(liveSection()).getByText('Awaiting live moderation and approval…')).toBeInTheDocument();
  });

  it('treats malformed history as best-effort and preserves authoritative submitted boards', async () => {
    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, { _id: 'live-submitted-1' }),
    });
    betsImplementation = () => Promise.resolve({ data: { malformed: true } });

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    await screen.findByText('Awaiting live moderation and approval…');

    expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeDisabled();
    expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled();

    await advanceTime(POLL_INTERVAL_MS);
    await waitFor(() => expect(getRequestCount('/api/slip/boards')).toBeGreaterThanOrEqual(2));
    expect(within(liveSection()).getByText('Awaiting live moderation and approval…')).toBeInTheDocument();
  });

  it('starts polling for server-submitted boards on mount and unlocks a declined replacement draft with a new id', async () => {
    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, {
        _id: 'live-submitted-1',
        rows: [buildRow({ betKind: BET_KIND.LIVE, oddsName: 'Home', oddsValue: 1.8, selectionId: 'home', quoteVersion: 1 })],
      }),
    });
    betsResponse = [{ slipId: 'live-submitted-1', status: BET_STATUS.PENDING }];

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    const liveInput = await screen.findByLabelText('Wager for LIVE SLIP');

    expect(liveInput).toBeDisabled();
    expect(within(liveSection()).getByText('Awaiting live moderation and approval…')).toBeInTheDocument();
    expect(getRequestCount('/api/bet')).toBe(1);

    await advanceTime(POLL_INTERVAL_MS);
    await waitFor(() => expect(getRequestCount('/api/slip/boards')).toBeGreaterThanOrEqual(2));
    expect(getRequestCount('/api/bet')).toBeGreaterThanOrEqual(2);

    const replacementRow = buildRow({
      betKind: BET_KIND.LIVE,
      oddsName: 'Away',
      oddsValue: 2.1,
      selectionId: 'away',
      quoteVersion: 2,
    });
    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: buildBoard(BET_KIND.LIVE, {
        _id: 'live-draft-2',
        status: SLIP_STATUS.DRAFT,
        sourceSlipId: 'live-submitted-1',
        declineReason: 'STALE_QUOTE',
        rows: [{
          ...replacementRow,
          moderation: buildModeration(replacementRow._id),
        }],
      }),
    });
    betsResponse = [{ slipId: 'live-submitted-1', status: BET_STATUS.DECLINED }];

    await advanceTime(POLL_INTERVAL_MS);

    await waitFor(() => expect(within(liveSection()).getByText('Declined: Quote changed')).toBeInTheDocument());
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeEnabled();
    expect(within(liveSection()).getByText('Current quote 2.1')).toBeInTheDocument();
    expect(within(liveSection()).getByText('Quote v2')).toBeInTheDocument();
    expect(within(liveSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });
    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: 'live-draft-2',
      wager: 22,
      placementAttemptId: 'placement-attempt-1',
    })));
  });

  it('reuses the in-flight placement attempt id for rapid double-clicks and allocates a new one for a later action', async () => {
    const firstLiveSubmit = createDeferred();
    let liveSubmitCount = 0;

    axios.post.mockImplementation((url, payload) => {
      if (url === '/api/slip/bet' && payload.betKind === BET_KIND.LIVE) {
        liveSubmitCount += 1;
        boardsResponse = getBoardsPayload({
          [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, {
            _id: payload.slipId,
            rows: [buildRow({ betKind: BET_KIND.LIVE, oddsName: 'Home', oddsValue: 1.8, selectionId: 'home', quoteVersion: 1 })],
          }),
        });
        betsResponse = [{ slipId: payload.slipId, status: BET_STATUS.PENDING }];
        return firstLiveSubmit.promise;
      }

      return Promise.resolve({ data: {} });
    });

    await renderSlip();

    await screen.findByLabelText('Wager for PRE-MATCH SLIP');
    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    const preMatchSection = () => screen.getByText('PRE-MATCH SLIP').closest('section');

    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
      await Promise.resolve();
    });

    expect(liveSubmitCount).toBe(1);
    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenNthCalledWith(1, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: 'placement-attempt-1',
    }));

    await act(async () => {
      firstLiveSubmit.resolve({ data: {} });
      await Promise.resolve();
    });

    await waitFor(() => expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled());

    fireEvent.change(screen.getByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '11' } });

    await act(async () => {
      fireEvent.click(within(preMatchSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(2, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.PRE_MATCH,
      slipId: `${BET_KIND.PRE_MATCH}-slip-1`,
      wager: 11,
      placementAttemptId: 'placement-attempt-2',
    })));
    expect(randomUUIDMock).toHaveBeenCalledTimes(2);
  });

  it('retries the same placement attempt id after an accepted submission response is lost', async () => {
    const authoritativeLiveBoard = createSubmittedBoard(BET_KIND.LIVE, {
      _id: `${BET_KIND.LIVE}-slip-1`,
      submittedEvent: {
        wager: 22,
      },
    });

    axios.post
      .mockRejectedValueOnce(buildAxiosError({ message: 'Network Error' }))
      .mockImplementationOnce((url, payload) => {
        if (url === '/api/slip/bet') {
          boardsResponse = getBoardsPayload({
            [BET_KIND.LIVE]: authoritativeLiveBoard,
          });
          betsResponse = [{ slipId: payload.slipId, status: BET_STATUS.PENDING }];
        }

        return Promise.resolve({ data: authoritativeLiveBoard });
      });

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await screen.findByText('Placement status is still reconciling. Retry with the same wager and selections.');
    expect(within(liveSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(1, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: 'placement-attempt-1',
    })));
    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(2, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: 'placement-attempt-1',
    })));
    await waitFor(() => expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled());
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toHaveValue(22);
    expect(screen.queryByText('Placement status is still reconciling. Retry with the same wager and selections.')).not.toBeInTheDocument();
    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
  });

  it('retries the same placement attempt id after a retryable 5xx response', async () => {
    const authoritativePreMatchBoard = createSubmittedBoard(BET_KIND.PRE_MATCH, {
      _id: `${BET_KIND.PRE_MATCH}-slip-1`,
      submittedEvent: {
        wager: 11,
      },
    });

    axios.post
      .mockRejectedValueOnce(buildAxiosError({ status: 503, data: { message: 'gateway unavailable' } }))
      .mockImplementationOnce((url, payload) => {
        if (url === '/api/slip/bet') {
          boardsResponse = getBoardsPayload({
            [BET_KIND.PRE_MATCH]: authoritativePreMatchBoard,
          });
          betsResponse = [{ slipId: payload.slipId, status: BET_STATUS.PENDING }];
        }

        return Promise.resolve({ data: authoritativePreMatchBoard });
      });

    await renderSlip();

    const preMatchSection = () => screen.getByText('PRE-MATCH SLIP').closest('section');
    fireEvent.change(screen.getByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '11' } });

    await act(async () => {
      fireEvent.click(within(preMatchSection()).getByRole('button', { name: 'BET!' }));
    });

    await screen.findByText('Placement status is still reconciling. Retry with the same wager and selections.');

    await act(async () => {
      fireEvent.click(within(preMatchSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(1, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.PRE_MATCH,
      slipId: `${BET_KIND.PRE_MATCH}-slip-1`,
      wager: 11,
      placementAttemptId: 'placement-attempt-1',
    })));
    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(2, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.PRE_MATCH,
      slipId: `${BET_KIND.PRE_MATCH}-slip-1`,
      wager: 11,
      placementAttemptId: 'placement-attempt-1',
    })));
    await waitFor(() => expect(within(preMatchSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled());
    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
  });

  it('hydrates an authoritative submitted board from a 409 conflict response', async () => {
    const authoritativeLiveBoard = createSubmittedBoard(BET_KIND.LIVE, {
      _id: `${BET_KIND.LIVE}-slip-1`,
      submittedEvent: {
        wager: 11,
      },
    });

    axios.post.mockImplementationOnce(() => {
      boardsResponse = getBoardsPayload({
        [BET_KIND.LIVE]: authoritativeLiveBoard,
      });
      betsResponse = [{ slipId: `${BET_KIND.LIVE}-slip-1`, status: BET_STATUS.PENDING }];

      return Promise.reject(buildAxiosError({
        status: 409,
        data: {
          message: 'slip already submitted by another placement attempt',
          slip: authoritativeLiveBoard,
          placement: {
            requestedPlacementAttemptId: 'placement-attempt-1',
            authoritativePlacementAttemptId: 'server-winning-attempt',
            outcome: 'conflict',
          },
        },
      }));
    });

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '44' } });

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled());
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeDisabled();
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toHaveValue(11);
    expect(screen.queryByText('slip already submitted by another placement attempt')).not.toBeInTheDocument();
    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
  });

  it('reloads a stale board conflict without disturbing the sibling board', async () => {
    const updatedLiveBoard = buildBoard(BET_KIND.LIVE, {
      boardRevision: 2,
      rows: [buildRow({ betKind: BET_KIND.LIVE, oddsName: 'Away', oddsValue: 2.4, selectionId: 'away', quoteVersion: 2 })],
    });

    axios.post.mockImplementationOnce(() => {
      boardsResponse = getBoardsPayload({
        [BET_KIND.LIVE]: updatedLiveBoard,
      });

      return Promise.reject(buildAxiosError({
        status: 409,
        data: {
          message: 'This slip changed before placement. Review the latest selections and try again.',
          slip: updatedLiveBoard,
          placement: {
            requestedPlacementAttemptId: 'placement-attempt-1',
            authoritativePlacementAttemptId: null,
            outcome: 'conflict',
          },
          reload: {
            required: true,
            reason: 'board-mismatch',
          },
        },
      }));
    });

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    const preMatchSection = () => screen.getByText('PRE-MATCH SLIP').closest('section');

    fireEvent.change(screen.getByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '11' } });
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: 'placement-attempt-1',
    })));
    await waitFor(() => expect(within(liveSection()).getByText('Away')).toBeInTheDocument());
    expect(within(liveSection()).getByText('This slip changed before placement. Review the latest selections and try again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toHaveValue(22);
    expect(within(liveSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();
    expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toHaveValue(11);
    expect(within(preMatchSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();
  });

  it('ignores late placement continuations after logout and a new same-user generation', async () => {
    const lateSubmit = createDeferred();
    const onBoardSubmitted = jest.fn();
    const onSelectionKeysChange = jest.fn();
    const submittedLiveBoard = createSubmittedBoard(BET_KIND.LIVE, {
      _id: `${BET_KIND.LIVE}-slip-1`,
      submittedEvent: {
        wager: 22,
      },
    });

    axios.post.mockImplementationOnce((url, payload) => {
      if (url === '/api/slip/bet') {
        boardsResponse = getBoardsPayload({
          [BET_KIND.LIVE]: submittedLiveBoard,
        });
        betsResponse = [{ slipId: payload.slipId, status: BET_STATUS.PENDING }];
        return lateSubmit.promise;
      }

      return Promise.resolve({ data: {} });
    });

    const { rerender } = await renderSlip({ onBoardSubmitted, onSelectionKeysChange });
    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');

    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });
    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
      await Promise.resolve();
    });

    expect(within(liveSection()).getByRole('button', { name: 'Submitting…' })).toBeDisabled();

    rerender(
      <Slip
        currentUser={null}
        onBoardSubmitted={onBoardSubmitted}
        onSelectionKeysChange={onSelectionKeysChange}
        refreshSignal={1}
        uiVariant="v2"
      />,
    );

    await waitFor(() => expect(screen.getAllByText('Login and bet!').length).toBeGreaterThan(0));

    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: null,
    });

    rerender(
      <Slip
        currentUser={{ id: 'user-1' }}
        onBoardSubmitted={onBoardSubmitted}
        onSelectionKeysChange={onSelectionKeysChange}
        refreshSignal={2}
        uiVariant="v2"
      />,
    );

    await waitFor(() => expect(screen.getByText('Build your live slip')).toBeInTheDocument());

    await act(async () => {
      lateSubmit.resolve({ data: submittedLiveBoard });
      await Promise.resolve();
    });
    await flushAsync();

    expect(screen.getByText('Build your live slip')).toBeInTheDocument();
    expect(screen.queryByText('Awaiting live moderation and approval…')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Wager for LIVE SLIP')).not.toBeInTheDocument();
    expect(onBoardSubmitted).not.toHaveBeenCalled();
  });

  it('blocks changed wagers from reusing an unresolved placement attempt and allows retry after reverting the payload', async () => {
    const authoritativeLiveBoard = createSubmittedBoard(BET_KIND.LIVE, {
      _id: `${BET_KIND.LIVE}-slip-1`,
      submittedEvent: {
        wager: 22,
      },
    });

    axios.post
      .mockRejectedValueOnce(buildAxiosError({ message: 'Network Error' }))
      .mockImplementationOnce((url, payload) => {
        if (url === '/api/slip/bet') {
          boardsResponse = getBoardsPayload({
            [BET_KIND.LIVE]: authoritativeLiveBoard,
          });
          betsResponse = [{ slipId: payload.slipId, status: BET_STATUS.PENDING }];
        }

        return Promise.resolve({ data: authoritativeLiveBoard });
      });

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    const liveWagerInput = screen.getByLabelText('Wager for LIVE SLIP');

    fireEvent.change(liveWagerInput, { target: { value: '22' } });
    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await screen.findByText('Placement status is still reconciling. Retry with the same wager and selections.');

    fireEvent.change(liveWagerInput, { target: { value: '30' } });
    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(within(liveSection()).getByText('This slip changed after a previous placement attempt. Wait for the slip to update before placing it again.')).toBeInTheDocument();

    fireEvent.change(liveWagerInput, { target: { value: '22' } });
    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(2, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: 'placement-attempt-1',
    })));
    await waitFor(() => expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled());
    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
  });

  it('retires a failed pre-claim attempt so a later deliberate action gets a new id', async () => {
    const authoritativeLiveBoard = createSubmittedBoard(BET_KIND.LIVE, {
      _id: `${BET_KIND.LIVE}-slip-1`,
      submittedEvent: {
        wager: 22,
      },
    });

    axios.post
      .mockRejectedValueOnce(buildAxiosError({
        status: 400,
        data: {
          message: 'slip contains mixed bet kinds',
        },
      }))
      .mockImplementationOnce((url, payload) => {
        if (url === '/api/slip/bet') {
          boardsResponse = getBoardsPayload({
            [BET_KIND.LIVE]: authoritativeLiveBoard,
          });
          betsResponse = [{ slipId: payload.slipId, status: BET_STATUS.PENDING }];
        }

        return Promise.resolve({ data: authoritativeLiveBoard });
      });

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await screen.findByText('slip contains mixed bet kinds');

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(1, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: 'placement-attempt-1',
    })));
    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(2, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: 'placement-attempt-2',
    })));
    await waitFor(() => expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled());
    expect(randomUUIDMock).toHaveBeenCalledTimes(2);
  });

  it('keeps PRE_MATCH and LIVE placement attempts isolated while retrying an ambiguous submission', async () => {
    const authoritativePreMatchBoard = createSubmittedBoard(BET_KIND.PRE_MATCH, {
      _id: `${BET_KIND.PRE_MATCH}-slip-1`,
      submittedEvent: {
        wager: 11,
      },
    });

    axios.post.mockImplementation((url, payload) => {
      if (url !== '/api/slip/bet') {
        return Promise.resolve({ data: {} });
      }

      if (payload.betKind === BET_KIND.LIVE) {
        return Promise.reject(buildAxiosError({ message: 'Network Error' }));
      }

      boardsResponse = getBoardsPayload({
        [BET_KIND.PRE_MATCH]: authoritativePreMatchBoard,
      });
      betsResponse = [{ slipId: payload.slipId, status: BET_STATUS.PENDING }];
      return Promise.resolve({ data: authoritativePreMatchBoard });
    });

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    const preMatchSection = () => screen.getByText('PRE-MATCH SLIP').closest('section');
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });
    fireEvent.change(screen.getByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '11' } });

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await screen.findByText('Placement status is still reconciling. Retry with the same wager and selections.');

    await act(async () => {
      fireEvent.click(within(preMatchSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(1, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: 'placement-attempt-1',
    })));
    await waitFor(() => expect(axios.post).toHaveBeenNthCalledWith(2, '/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.PRE_MATCH,
      slipId: `${BET_KIND.PRE_MATCH}-slip-1`,
      wager: 11,
      placementAttemptId: 'placement-attempt-2',
    })));
    await waitFor(() => expect(within(preMatchSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled());
    expect(within(liveSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();
    expect(randomUUIDMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to window.crypto.getRandomValues when randomUUID is unavailable', async () => {
    const fallbackCrypto = createFallbackCrypto([
      0x00,
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      0x07,
      0x08,
      0x09,
      0x0a,
      0x0b,
      0x0c,
      0x0d,
      0x0e,
      0x0f,
    ]);
    setWindowCrypto(fallbackCrypto);

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/slip/bet', buildPlacementRequest({
      betKind: BET_KIND.LIVE,
      slipId: `${BET_KIND.LIVE}-slip-1`,
      wager: 22,
      placementAttemptId: '00010203-0405-4607-8809-0a0b0c0d0e0f',
    })));
    expect(fallbackCrypto.getRandomValues).toHaveBeenCalledTimes(1);
    expect(randomUUIDMock).not.toHaveBeenCalled();
  });

  it('surfaces an explicit error when secure crypto is unavailable instead of inventing a weak attempt id', async () => {
    setWindowCrypto(undefined);

    await renderSlip();

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    expect(axios.post).not.toHaveBeenCalled();
    expect(within(liveSection()).getByText('Secure random placement attempt ids are unavailable')).toBeInTheDocument();
  });

  it('ignores slow out-of-order history enrichment once newer authoritative boards arrive', async () => {
    const slowHistory = createDeferred();
    let historyCalls = 0;

    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, { _id: 'live-submitted-1' }),
    });
    betsImplementation = () => {
      historyCalls += 1;
      if (historyCalls === 1) {
        return slowHistory.promise;
      }

      return Promise.resolve({ data: betsResponse });
    };

    const { rerender } = await renderSlip();

    await screen.findByText('Awaiting live moderation and approval…');

    const replacementRow = buildRow({
      betKind: BET_KIND.LIVE,
      oddsName: 'Away',
      oddsValue: 2.4,
      selectionId: 'away',
      quoteVersion: 3,
    });
    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: buildBoard(BET_KIND.LIVE, {
        _id: 'live-draft-2',
        status: SLIP_STATUS.DRAFT,
        sourceSlipId: 'live-submitted-1',
        declineReason: 'STALE_QUOTE',
        rows: [{
          ...replacementRow,
          moderation: buildModeration(replacementRow._id),
        }],
      }),
    });
    betsResponse = [{ slipId: 'live-submitted-1', status: BET_STATUS.CONFIRMED }];

    rerender(
      <Slip
        currentUser={{ id: 'user-1' }}
        onBoardSubmitted={jest.fn()}
        onSelectionKeysChange={jest.fn()}
        refreshSignal={1}
        uiVariant="v2"
      />,
    );

    await advanceTime(REFRESH_DELAY_MS);
    await waitFor(() => expect(screen.getByText('Declined: Quote changed')).toBeInTheDocument());

    await act(async () => {
      slowHistory.resolve({ data: [{ slipId: 'live-submitted-1', status: BET_STATUS.CONFIRMED }] });
      await Promise.resolve();
    });

    expect(screen.getByText('Declined: Quote changed')).toBeInTheDocument();
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeEnabled();
    expect(screen.queryByText('Build your live slip')).not.toBeInTheDocument();
  });

  it('prefers authoritative replacement drafts over local submitted snapshots and keeps kinds independent', async () => {
    axios.post.mockImplementation((url, payload) => {
      if (url === '/api/slip/bet' && payload.betKind === BET_KIND.LIVE) {
        const replacementRow = buildRow({
          betKind: BET_KIND.LIVE,
          oddsName: 'Away',
          oddsValue: 2.4,
          selectionId: 'away',
          quoteVersion: 3,
        });
        boardsResponse = getBoardsPayload({
          [BET_KIND.LIVE]: buildBoard(BET_KIND.LIVE, {
            _id: 'live-replacement-2',
            status: SLIP_STATUS.DRAFT,
            sourceSlipId: payload.slipId,
            declineReason: 'STALE_QUOTE',
            rows: [{
              ...replacementRow,
              moderation: buildModeration(replacementRow._id),
            }],
          }),
        });
        betsResponse = [{ slipId: payload.slipId, status: BET_STATUS.DECLINED }];
      }

      return Promise.resolve({ data: {} });
    });

    await renderSlip();

    await screen.findByLabelText('Wager for PRE-MATCH SLIP');
    await screen.findByLabelText('Wager for LIVE SLIP');

    fireEvent.change(screen.getByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '11' } });
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '33' } });

    const liveSection = () => screen.getByText('LIVE SLIP').closest('section');
    const preMatchSection = () => screen.getByText('PRE-MATCH SLIP').closest('section');

    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(within(liveSection()).getByText('Declined: Quote changed')).toBeInTheDocument());
    expect(within(liveSection()).queryByText('Awaiting live moderation and approval…')).not.toBeInTheDocument();
    expect(within(liveSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();
    expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toHaveValue(11);
    expect(within(preMatchSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toHaveValue(33);
  });

  it('clears pending state when approved history removes a submitted board', async () => {
    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, { _id: 'live-submitted-1' }),
    });
    betsResponse = [{ slipId: 'live-submitted-1', status: BET_STATUS.PENDING }];

    await renderSlip();

    await screen.findByText('Awaiting live moderation and approval…');
    const getLiveSection = () => screen.getByText('LIVE SLIP').closest('section');

    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: null,
    });
    betsResponse = [{ slipId: 'live-submitted-1', status: BET_STATUS.CONFIRMED }];

    await advanceTime(POLL_INTERVAL_MS);

    await waitFor(() => expect(within(getLiveSection()).getByText('Build your live slip')).toBeInTheDocument());
    expect(within(getLiveSection()).queryByText('Awaiting live moderation and approval…')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Wager for LIVE SLIP')).not.toBeInTheDocument();

    const callsAfterClear = axios.get.mock.calls.length;
    await advanceTime(POLL_INTERVAL_MS * 2);
    expect(axios.get.mock.calls.length).toBe(callsAfterClear);
  });

  it('cleans up polling timers on unmount during in-flight history enrichment', async () => {
    const slowHistory = createDeferred();

    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, { _id: 'live-submitted-1' }),
    });
    betsImplementation = () => slowHistory.promise;

    const { unmount } = await renderSlip();

    await screen.findByText('Awaiting live moderation and approval…');
    const requestCountBeforeUnmount = axios.get.mock.calls.length;

    unmount();

    await act(async () => {
      slowHistory.resolve({ data: [{ slipId: 'live-submitted-1', status: BET_STATUS.CONFIRMED }] });
      await Promise.resolve();
    });
    await flushAsync();
    await advanceTime(POLL_INTERVAL_MS * 2 + REFRESH_DELAY_MS);

    expect(axios.get.mock.calls.length).toBe(requestCountBeforeUnmount);
  });
});
