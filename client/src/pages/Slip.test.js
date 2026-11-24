import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import Slip from './Slip';
import { BET_KIND, BET_STATUS, getLiveSelectionKey, getPreMatchSelectionKey } from '../liveBettingUtils';
import { GUEST_LOAD_ERROR, POLL_INTERVAL_MS, REFRESH_DELAY_MS, SLIP_STATUS } from '../hook/useSlipBoards';

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

// The Slip shows one board at a time and role queries skip the hidden panel, so select the board first.
const openTab = (label) => {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${label}`) }));
};

const LocationProbe = () => {
  const { pathname, search } = useLocation();

  return <output data-testid="location">{`${pathname}${search}`}</output>;
};

describe('Slip', () => {
  let boardsResponse;
  let betsResponse;
  let betsImplementation;
  let originalCrypto;
  let randomUUIDMock;

  const slipElement = (props = {}) => (
    <Slip
      currentUser={{ id: 'user-1' }}
      isCurrentUserResolved
      onBoardSubmitted={jest.fn()}
      onSelectionKeysChange={jest.fn()}
      refreshSignal={0}
      uiVariant="v2"
      {...props}
    />
  );

  // A guest's "Log in to bet" button navigates, so these renders sit inside a router.
  // The slip is signed out unless a currentUser is passed.
  const routedElement = ({ currentUser = null, ...props } = {}, initialEntry = '/') => (
    <MemoryRouter initialEntries={[initialEntry]}>
      {slipElement({ currentUser, ...props })}
      <LocationProbe />
    </MemoryRouter>
  );

  const renderSlip = async (props = {}) => {
    let renderResult;
    await act(async () => {
      renderResult = render(slipElement(props));
    });

    return renderResult;
  };

  const renderRouted = async (props = {}, initialEntry = '/') => {
    let renderResult;
    await act(async () => {
      renderResult = render(routedElement(props, initialEntry));
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

    openTab('Live');
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
    openTab('Live');
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
    openTab('Live');
    expect(within(liveSection()).getByRole('button', { name: 'Awaiting review…' })).toBeDisabled();

    await advanceTime(POLL_INTERVAL_MS);
    await waitFor(() => expect(getRequestCount('/api/slip/boards')).toBeGreaterThanOrEqual(2));
    expect(within(liveSection()).getByText('Awaiting live moderation and approval…')).toBeInTheDocument();
  });

  it('keeps the recorded risk title through board normalization without attributing it to an unaffected row', async () => {
    const affected = buildRow({ moderation: { rowId: 'risk-row', declineReason: 'RISK_POLICY', reasonCodes: ['RISK_MIN_STAKE'] } });
    boardsResponse = getBoardsPayload({
      [BET_KIND.PRE_MATCH]: buildBoard(BET_KIND.PRE_MATCH, {
        declineReason: 'RISK_POLICY', reasonCodes: ['RISK_MIN_STAKE'],
        rows: [affected, buildRow({ oddsName: 'Unaffected selection' })],
      }),
    });
    await renderSlip();
    expect(screen.getByText('Declined: Minimum stake')).toBeVisible();
    expect(screen.getAllByText(/Minimum stake/)).toHaveLength(1);
    expect(screen.getByText('1 declined selection')).toBeVisible();
    expect(screen.queryByText('Risk policy restriction')).not.toBeInTheDocument();
  });

  it('shows a whole-ticket decline once on the slip instead of repeating it on every row', async () => {
    const moderation = (rowId) => ({ rowId, declineReason: 'RISK_POLICY', reasonCodes: ['RISK_MIN_STAKE'] });
    boardsResponse = getBoardsPayload({
      [BET_KIND.PRE_MATCH]: buildBoard(BET_KIND.PRE_MATCH, {
        declineReason: 'RISK_POLICY', reasonCodes: ['RISK_MIN_STAKE'],
        rows: [buildRow({ moderation: moderation('a') }), buildRow({ oddsName: 'Draw', moderation: moderation('b') })],
      }),
    });
    await renderSlip();
    expect(screen.getAllByText(/Minimum stake/)).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent('Declined: Minimum stake');
    expect(screen.queryByText(/declined selection/)).not.toBeInTheDocument();
  });

  it('keeps a selection-specific decline on its row even when every row is affected', async () => {
    boardsResponse = getBoardsPayload({
      [BET_KIND.PRE_MATCH]: buildBoard(BET_KIND.PRE_MATCH, {
        declineReason: 'STALE_QUOTE',
        rows: [buildRow({ moderation: buildModeration('a') }), buildRow({ oddsName: 'Draw', moderation: buildModeration('b') })],
      }),
    });
    await renderSlip();
    expect(screen.getAllByText('Declined: Quote changed')).toHaveLength(2);
    expect(screen.getByText('2 declined selections')).toBeVisible();
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
    openTab('Live');
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

    openTab('Live');
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

    openTab('Pre-match');
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

    openTab('Live');
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
    openTab('Live');
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

    openTab('Live');
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
    openTab('Pre-match');
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

    openTab('Live');
    fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '22' } });
    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
      await Promise.resolve();
    });

    expect(within(liveSection()).getByRole('button', { name: 'Submitting…' })).toBeDisabled();

    // The server answers the logged-out request with an empty guest slip.
    boardsResponse = getBoardsPayload({
      [BET_KIND.PRE_MATCH]: null,
      [BET_KIND.LIVE]: null,
    });

    rerender(
      <Slip
        currentUser={null}
        isCurrentUserResolved
        onBoardSubmitted={onBoardSubmitted}
        onSelectionKeysChange={onSelectionKeysChange}
        refreshSignal={1}
        uiVariant="v2"
      />,
    );

    // Guests see the same empty-state copy as signed-in users, and the previous slip is gone.
    await waitFor(() => expect(screen.getByText('Build your live slip')).toBeInTheDocument());
    expect(screen.getByText('Build your pre-match slip')).toBeInTheDocument();
    expect(screen.queryByText('Pre-match Clash')).not.toBeInTheDocument();
    expect(screen.queryByText('Login and bet!')).not.toBeInTheDocument();

    boardsResponse = getBoardsPayload({
      [BET_KIND.LIVE]: null,
    });

    rerender(
      <Slip
        currentUser={{ id: 'user-1' }}
        isCurrentUserResolved
        onBoardSubmitted={onBoardSubmitted}
        onSelectionKeysChange={onSelectionKeysChange}
        refreshSignal={2}
        uiVariant="v2"
      />,
    );

    await waitFor(() => expect(screen.getByText('Pre-match Clash')).toBeInTheDocument());
    expect(screen.getByText('Build your live slip')).toBeInTheDocument();

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

    openTab('Live');
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

    openTab('Live');
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

    openTab('Live');
    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await screen.findByText('Placement status is still reconciling. Retry with the same wager and selections.');

    openTab('Pre-match');
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
    openTab('Live');
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
    openTab('Live');
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
    openTab('Live');
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

    openTab('Live');
    await act(async () => {
      fireEvent.click(within(liveSection()).getByRole('button', { name: 'BET!' }));
    });

    await waitFor(() => expect(within(liveSection()).getByText('Declined: Quote changed')).toBeInTheDocument());
    expect(within(liveSection()).queryByText('Awaiting live moderation and approval…')).not.toBeInTheDocument();
    expect(within(liveSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();
    expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toHaveValue(11);
    openTab('Pre-match');
    expect(within(preMatchSection()).getByRole('button', { name: 'BET!' })).toBeEnabled();
    expect(screen.getByLabelText('Wager for LIVE SLIP')).toHaveValue(33);
  });

  it.each([BET_STATUS.CONFIRMED, BET_STATUS.CASH_BACK])('clears pending state when %s history removes a submitted board', async (historyStatus) => {
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
    betsResponse = [{ slipId: 'live-submitted-1', status: historyStatus }];

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

  describe('tabs', () => {
    it('renders one Slip tablist whose tabs label the two mounted board panels', async () => {
      await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      const tablist = screen.getByRole('tablist', { name: 'Slip' });
      const tabs = within(tablist).getAllByRole('tab');
      const preMatchTab = within(tablist).getByRole('tab', { name: 'Pre-match (1)' });
      const liveTab = within(tablist).getByRole('tab', { name: 'Live (1)' });

      expect(tabs).toHaveLength(2);
      expect(tabs[0]).toBe(preMatchTab);
      expect(tabs[1]).toBe(liveTab);
      expect(preMatchTab).toHaveAttribute('aria-selected', 'true');
      expect(preMatchTab).toHaveAttribute('tabindex', '0');
      expect(preMatchTab).toHaveAttribute('aria-controls', 'slip-panel-PRE_MATCH');
      expect(preMatchTab).not.toHaveAttribute('title');
      expect(liveTab).toHaveAttribute('aria-selected', 'false');
      expect(liveTab).toHaveAttribute('tabindex', '-1');
      expect(liveTab).toHaveAttribute('aria-controls', 'slip-panel-LIVE');
      expect(liveTab).not.toHaveAttribute('title');

      const preMatchPanel = screen.getByRole('tabpanel', { name: 'Pre-match (1)' });
      expect(preMatchPanel).toHaveAttribute('id', 'slip-panel-PRE_MATCH');
      expect(preMatchPanel).toHaveAttribute('aria-labelledby', preMatchTab.id);
      expect(preMatchPanel).toBeVisible();

      // The inactive panel stays mounted and is only hidden.
      const livePanel = document.getElementById('slip-panel-LIVE');
      expect(livePanel).toHaveAttribute('role', 'tabpanel');
      expect(livePanel).toHaveAttribute('aria-labelledby', liveTab.id);
      expect(livePanel).toHaveAttribute('hidden');
      expect(screen.queryByRole('tabpanel', { name: 'Live (1)' })).not.toBeInTheDocument();
    });

    it('keeps the board sections, heading ids and wager labels the release gate selects', async () => {
      await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      const preMatchSection = document.querySelector('section[aria-labelledby="slip-board-title-PRE_MATCH"]');
      const liveSection = document.querySelector('section[aria-labelledby="slip-board-title-LIVE"]');

      expect(preMatchSection).toBe(screen.getByText('PRE-MATCH SLIP').closest('section'));
      expect(liveSection).toBe(screen.getByText('LIVE SLIP').closest('section'));
      expect(document.getElementById('slip-board-title-PRE_MATCH')).toHaveTextContent('PRE-MATCH SLIP');
      expect(document.getElementById('slip-board-title-LIVE')).toHaveTextContent('LIVE SLIP');
      expect(preMatchSection.closest('[role="tabpanel"]')).toHaveAttribute('id', 'slip-panel-PRE_MATCH');
      expect(liveSection.closest('[role="tabpanel"]')).toHaveAttribute('id', 'slip-panel-LIVE');
      expect(within(preMatchSection).getByLabelText('Wager for PRE-MATCH SLIP')).toBeInTheDocument();
      expect(within(liveSection).getByLabelText('Wager for LIVE SLIP')).toBeInTheDocument();
    });

    it('shows each board row count on its tab and no badge for an empty board', async () => {
      boardsResponse = getBoardsPayload({
        [BET_KIND.PRE_MATCH]: buildBoard(BET_KIND.PRE_MATCH, {
          rows: [buildRow({ oddsName: 'Team A' }), buildRow({ oddsName: 'Team B' })],
        }),
        [BET_KIND.LIVE]: null,
      });

      await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      expect(screen.getByRole('tab', { name: 'Pre-match (2)' })).toHaveTextContent('Pre-match2');
      const liveTab = screen.getByRole('tab', { name: 'Live' });
      expect(liveTab).toHaveTextContent(/^Live$/);
      expect(liveTab).not.toHaveAttribute('aria-label');
    });

    it('keeps the tab counts in step with the boards after a row is removed', async () => {
      await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      expect(screen.getByRole('tab', { name: 'Pre-match (1)' })).toBeInTheDocument();

      boardsResponse = getBoardsPayload({ [BET_KIND.PRE_MATCH]: null });
      fireEvent.click(screen.getByRole('button', { name: 'Remove Team A from Pre-match slip' }));

      await waitFor(() => expect(screen.getByRole('tab', { name: 'Pre-match' })).toBeInTheDocument());
      expect(axios.post).toHaveBeenCalledWith('/api/slip/row', {
        betKind: BET_KIND.PRE_MATCH,
        slipId: 'PRE_MATCH-slip-1',
        slipRowId: 'PRE_MATCH-Team A-1',
      });
      expect(screen.getByRole('tab', { name: 'Live (1)' })).toBeInTheDocument();
    });

    it('activates a tab on click and keeps the typed wager in the same mounted input', async () => {
      await renderSlip();
      const preMatchWager = await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      fireEvent.change(preMatchWager, { target: { value: '12' } });
      expect(preMatchWager).toBeVisible();
      expect(screen.getByLabelText('Wager for LIVE SLIP')).not.toBeVisible();

      openTab('Live');

      expect(screen.getByRole('tab', { name: 'Live (1)' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Live (1)' })).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('tab', { name: 'Pre-match (1)' })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tab', { name: 'Pre-match (1)' })).toHaveAttribute('tabindex', '-1');
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeVisible();
      expect(preMatchWager).not.toBeVisible();

      openTab('Pre-match');

      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toBe(preMatchWager);
      expect(preMatchWager).toBeVisible();
      expect(preMatchWager).toHaveValue(12);
    });

    it('moves focus and selection with the arrow, Home and End keys', async () => {
      await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      const preMatchTab = screen.getByRole('tab', { name: 'Pre-match (1)' });
      const liveTab = screen.getByRole('tab', { name: 'Live (1)' });
      preMatchTab.focus();

      fireEvent.keyDown(preMatchTab, { key: 'ArrowRight' });
      expect(liveTab).toHaveFocus();
      expect(liveTab).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeVisible();

      fireEvent.keyDown(liveTab, { key: 'ArrowRight' });
      expect(preMatchTab).toHaveFocus();
      expect(preMatchTab).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toBeVisible();

      fireEvent.keyDown(preMatchTab, { key: 'ArrowLeft' });
      expect(liveTab).toHaveFocus();
      expect(liveTab).toHaveAttribute('aria-selected', 'true');

      fireEvent.keyDown(liveTab, { key: 'Home' });
      expect(preMatchTab).toHaveFocus();
      expect(preMatchTab).toHaveAttribute('aria-selected', 'true');

      fireEvent.keyDown(preMatchTab, { key: 'End' });
      expect(liveTab).toHaveFocus();
      expect(liveTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('initial tab', () => {
    it('opens Pre-match when both boards have rows', async () => {
      await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      expect(screen.getByRole('tab', { name: 'Pre-match (1)' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toBeVisible();
    });

    it('opens Pre-match when both boards are empty', async () => {
      boardsResponse = getBoardsPayload({ [BET_KIND.PRE_MATCH]: null, [BET_KIND.LIVE]: null });

      await renderSlip();
      await screen.findByText('Build your pre-match slip');

      expect(screen.getByRole('tab', { name: 'Pre-match' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Build your pre-match slip')).toBeVisible();
    });

    it('opens Live when only Live has rows on the first load', async () => {
      boardsResponse = getBoardsPayload({ [BET_KIND.PRE_MATCH]: null });

      await renderSlip();
      await screen.findByLabelText('Wager for LIVE SLIP');

      expect(screen.getByRole('tab', { name: 'Live (1)' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeVisible();
      expect(screen.getByRole('button', { name: 'BET!' })).toBeEnabled();
    });

    it('does not move the tab after the first load when the boards change', async () => {
      boardsResponse = getBoardsPayload({ [BET_KIND.PRE_MATCH]: null });
      const { rerender } = await renderSlip();
      await screen.findByLabelText('Wager for LIVE SLIP');
      expect(screen.getByRole('tab', { name: 'Live (1)' })).toHaveAttribute('aria-selected', 'true');

      boardsResponse = getBoardsPayload();
      rerender(slipElement({ refreshSignal: 1 }));
      await advanceTime(REFRESH_DELAY_MS);

      await waitFor(() => expect(screen.getByRole('tab', { name: 'Pre-match (1)' })).toBeInTheDocument());
      expect(screen.getByRole('tab', { name: 'Live (1)' })).toHaveAttribute('aria-selected', 'true');
    });

    it('stays on Pre-match when its board is emptied after the first load', async () => {
      const { rerender } = await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      boardsResponse = getBoardsPayload({ [BET_KIND.PRE_MATCH]: null });
      rerender(slipElement({ refreshSignal: 1 }));
      await advanceTime(REFRESH_DELAY_MS);

      await screen.findByText('Build your pre-match slip');
      expect(screen.getByRole('tab', { name: 'Pre-match' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Live (1)' })).toHaveAttribute('aria-selected', 'false');
    });

    it('keeps a tab chosen before the first load instead of applying the first-load rule', async () => {
      const boardsLoad = createDeferred();
      axios.get.mockImplementation((url) => (
        url === '/api/slip/boards'
          ? boardsLoad.promise
          : Promise.reject(new Error(`Unexpected GET ${url}`))
      ));

      await renderSlip();
      openTab('Live');
      openTab('Pre-match');
      await act(async () => {
        boardsLoad.resolve({ data: getBoardsPayload({ [BET_KIND.PRE_MATCH]: null }) });
      });
      await screen.findByLabelText('Wager for LIVE SLIP');

      expect(screen.getByRole('tab', { name: 'Pre-match' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Build your pre-match slip')).toBeVisible();
    });
  });

  describe('jump on add', () => {
    const expectSelectedTab = (name) => {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    };

    it('activates the Live tab when a live pick is placed and still refreshes the boards', async () => {
      const { rerender } = await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      expectSelectedTab('Pre-match (1)');

      rerender(slipElement({ refreshSignal: 1, tabRequest: { betKind: BET_KIND.LIVE, nonce: 1 } }));

      expectSelectedTab('Live (1)');
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeVisible();
      await advanceTime(REFRESH_DELAY_MS);
      expect(getRequestCount('/api/slip/boards')).toBe(2);
      expectSelectedTab('Live (1)');
    });

    it('activates the Pre-match tab when a pre-match pick is placed', async () => {
      boardsResponse = getBoardsPayload({ [BET_KIND.PRE_MATCH]: null });
      const { rerender } = await renderSlip();
      await screen.findByLabelText('Wager for LIVE SLIP');
      expectSelectedTab('Live (1)');

      boardsResponse = getBoardsPayload();
      rerender(slipElement({ refreshSignal: 1, tabRequest: { betKind: BET_KIND.PRE_MATCH, nonce: 1 } }));

      expectSelectedTab('Pre-match');
      await advanceTime(REFRESH_DELAY_MS);
      await waitFor(() => expectSelectedTab('Pre-match (1)'));
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toBeVisible();
    });

    it('re-activates the same kind for every new request and ignores a repeated one', async () => {
      const { rerender } = await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      rerender(slipElement({ refreshSignal: 1, tabRequest: { betKind: BET_KIND.LIVE, nonce: 1 } }));
      expectSelectedTab('Live (1)');

      openTab('Pre-match');
      expectSelectedTab('Pre-match (1)');
      rerender(slipElement({ refreshSignal: 2, tabRequest: { betKind: BET_KIND.LIVE, nonce: 2 } }));
      expectSelectedTab('Live (1)');

      openTab('Pre-match');
      rerender(slipElement({ refreshSignal: 3, tabRequest: { betKind: BET_KIND.LIVE, nonce: 2 } }));
      await advanceTime(REFRESH_DELAY_MS);
      expectSelectedTab('Pre-match (1)');
    });

    it('never changes the tab for a refresh that carries no new request', async () => {
      const { rerender } = await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      openTab('Live');

      rerender(slipElement({ refreshSignal: 1, tabRequest: null }));
      await advanceTime(REFRESH_DELAY_MS);
      expectSelectedTab('Live (1)');

      // A login or logout refresh while the app still holds the last placed-pick request.
      const lastRequest = { betKind: BET_KIND.LIVE, nonce: 1 };
      rerender(slipElement({ refreshSignal: 2, tabRequest: lastRequest }));
      expectSelectedTab('Live (1)');
      openTab('Pre-match');
      rerender(slipElement({ refreshSignal: 3, tabRequest: lastRequest }));
      await advanceTime(REFRESH_DELAY_MS);
      expectSelectedTab('Pre-match (1)');
      expect(getRequestCount('/api/slip/boards')).toBeGreaterThanOrEqual(3);
    });

    it('ignores a request that predates the mount and a request for an unknown kind', async () => {
      const { rerender } = await renderSlip({ tabRequest: { betKind: BET_KIND.LIVE, nonce: 4 } });
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      expectSelectedTab('Pre-match (1)');

      rerender(slipElement({ refreshSignal: 1, tabRequest: { betKind: 'FUTURES', nonce: 5 } }));
      expectSelectedTab('Pre-match (1)');

      rerender(slipElement({ refreshSignal: 2, tabRequest: { betKind: BET_KIND.LIVE, nonce: 6 } }));
      expectSelectedTab('Live (1)');
      await advanceTime(REFRESH_DELAY_MS);
    });
  });

  describe('per-tab state', () => {
    it('keeps typed wagers separate per tab across tab switches', async () => {
      await renderSlip();
      const preMatchWager = await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      const liveWager = screen.getByLabelText('Wager for LIVE SLIP');

      fireEvent.change(preMatchWager, { target: { value: '12' } });
      openTab('Live');
      fireEvent.change(liveWager, { target: { value: '7' } });
      openTab('Pre-match');
      openTab('Live');
      openTab('Pre-match');

      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toBe(preMatchWager);
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toBe(liveWager);
      expect(preMatchWager).toHaveValue(12);
      expect(liveWager).toHaveValue(7);
    });

    it('keeps a board error on the tab that raised it', async () => {
      axios.post.mockImplementation((url) => (
        url === '/api/slip/row'
          ? Promise.reject(buildAxiosError({ status: 500, data: { message: 'Selection is locked' } }))
          : Promise.resolve({ data: {} })
      ));
      await renderSlip();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      fireEvent.click(screen.getByRole('button', { name: 'Remove Team A from Pre-match slip' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Selection is locked');

      openTab('Live');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      openTab('Pre-match');
      expect(screen.getByRole('alert')).toHaveTextContent('Selection is locked');
    });

    it('keeps a pending placement on its own tab while the other tab stays editable', async () => {
      const preMatchSubmit = createDeferred();
      axios.post.mockImplementation((url, payload) => (
        url === '/api/slip/bet' && payload.betKind === BET_KIND.PRE_MATCH
          ? preMatchSubmit.promise
          : Promise.resolve({ data: {} })
      ));

      await renderSlip();
      fireEvent.change(await screen.findByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '11' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'BET!' }));
      });
      expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toBeDisabled();

      openTab('Live');
      expect(screen.getByRole('button', { name: 'BET!' })).toBeEnabled();
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeEnabled();

      openTab('Pre-match');
      expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();

      await act(async () => {
        preMatchSubmit.resolve({ data: {} });
      });
    });

    it('keeps the awaiting-review state on the Live tab while Pre-match stays editable', async () => {
      boardsResponse = getBoardsPayload({
        [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, { _id: 'live-submitted-1' }),
      });
      betsResponse = [{ slipId: 'live-submitted-1', status: BET_STATUS.PENDING }];

      await renderSlip();
      await screen.findByText('Awaiting live moderation and approval…');

      expect(screen.getByRole('button', { name: 'BET!' })).toBeEnabled();
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toBeEnabled();

      openTab('Live');
      expect(screen.getByRole('button', { name: 'Awaiting review…' })).toBeDisabled();
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'BET!' })).not.toBeInTheDocument();

      openTab('Pre-match');
      expect(screen.getByRole('button', { name: 'BET!' })).toBeEnabled();
    });
  });

  describe('guest slip', () => {
    const preMatchKey = getPreMatchSelectionKey({
      eventId: 'PRE_MATCH-event-1',
      productId: 'product-1',
      oddsId: 'odds-home',
    });
    const liveKey = getLiveSelectionKey({
      eventId: 'LIVE-event-1',
      marketId: 'market-1',
      marketVersion: 1,
      selectionId: 'home',
    });

    it('loads the guest boards once, without history, and never polls', async () => {
      await renderRouted();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      expect(screen.getByRole('tab', { name: 'Pre-match (1)' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Live (1)' })).toBeInTheDocument();
      expect(getRequestCount('/api/slip/boards')).toBe(1);

      await advanceTime(POLL_INTERVAL_MS * 3);

      expect(getRequestCount('/api/slip/boards')).toBe(1);
      expect(getRequestCount('/api/bet')).toBe(0);
    });

    it('does not poll a guest even when a board arrives marked as submitted', async () => {
      boardsResponse = getBoardsPayload({
        [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, { _id: 'live-submitted-1' }),
      });

      await renderRouted();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      await advanceTime(POLL_INTERVAL_MS * 3);

      expect(getRequestCount('/api/slip/boards')).toBe(1);
      expect(getRequestCount('/api/bet')).toBe(0);
    });

    it('loads nothing while auth is unresolved and loads once it resolves with no user', async () => {
      const { rerender } = await renderRouted({ isCurrentUserResolved: false });

      expect(getRequestCount('/api/slip/boards')).toBe(0);
      expect(screen.getByRole('tablist', { name: 'Slip' })).toBeInTheDocument();
      expect(screen.getByText('Loading pre-match slip…')).toBeInTheDocument();

      await act(async () => {
        rerender(routedElement({ isCurrentUserResolved: true }));
      });

      await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      expect(getRequestCount('/api/slip/boards')).toBe(1);
    });

    it('does not reload a guest slip while auth re-resolves with no user', async () => {
      const { rerender } = await renderRouted();
      fireEvent.change(await screen.findByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '9' } });

      rerender(routedElement({ isCurrentUserResolved: false }));
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toHaveValue(9);
      await act(async () => {
        rerender(routedElement({ isCurrentUserResolved: true }));
      });

      expect(getRequestCount('/api/slip/boards')).toBe(1);
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toHaveValue(9);
    });

    it('reloads the guest slip once per refresh signal', async () => {
      const { rerender } = await renderRouted();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      boardsResponse = getBoardsPayload({ [BET_KIND.LIVE]: null });
      rerender(routedElement({ refreshSignal: 1 }));
      await advanceTime(REFRESH_DELAY_MS);

      await waitFor(() => expect(screen.getByRole('tab', { name: 'Live' })).toBeInTheDocument());
      expect(getRequestCount('/api/slip/boards')).toBe(2);
      await advanceTime(POLL_INTERVAL_MS * 3);
      expect(getRequestCount('/api/slip/boards')).toBe(2);
    });

    it('reports guest picks for highlighting exactly like a signed-in user', async () => {
      const onSelectionKeysChange = jest.fn();

      await renderRouted({ onSelectionKeysChange });
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      const reportedKeys = onSelectionKeysChange.mock.calls[onSelectionKeysChange.mock.calls.length - 1][0];
      expect([...reportedKeys].sort()).toEqual([liveKey, preMatchKey].sort());
    });

    it('removes a row and cleans a board for a guest through the shared endpoints', async () => {
      await renderRouted();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      boardsResponse = getBoardsPayload({ [BET_KIND.PRE_MATCH]: null });
      fireEvent.click(screen.getByRole('button', { name: 'Remove Team A from Pre-match slip' }));

      await screen.findByText('Build your pre-match slip');
      expect(axios.post).toHaveBeenCalledWith('/api/slip/row', {
        betKind: BET_KIND.PRE_MATCH,
        slipId: 'PRE_MATCH-slip-1',
        slipRowId: 'PRE_MATCH-Team A-1',
      });
      expect(getRequestCount('/api/slip/boards')).toBe(2);

      openTab('Live');
      boardsResponse = getBoardsPayload({ [BET_KIND.PRE_MATCH]: null, [BET_KIND.LIVE]: null });
      fireEvent.click(screen.getByRole('button', { name: 'CLEAN' }));

      await screen.findByText('Build your live slip');
      expect(axios.post).toHaveBeenCalledWith('/api/slip/row/clean', {
        betKind: BET_KIND.LIVE,
        slipId: 'LIVE-slip-1',
      });
      expect(getRequestCount('/api/slip/boards')).toBe(3);
      expect(getRequestCount('/api/bet')).toBe(0);
    });

    it('shows "Log in to bet" instead of placing: enabled, untitled, and it leads to the login page', async () => {
      await renderRouted({}, '/events?ui=v2&theme=dark');
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      const loginToBet = screen.getByRole('button', { name: 'Log in to bet' });
      expect(loginToBet).toBeEnabled();
      expect(loginToBet).toHaveTextContent(/^Log in to bet$/);
      expect(loginToBet).not.toHaveAttribute('title');
      // The release gate selects the header icon by its title and the login submit by its exact name.
      expect(screen.queryByTitle('Log in')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'BET!' })).not.toBeInTheDocument();
      expect(screen.queryByText('Login and bet!')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toBeEnabled();
      expect(screen.getByRole('button', { name: 'CLEAN' })).toBeEnabled();

      fireEvent.click(loginToBet);

      expect(screen.getByTestId('location')).toHaveTextContent('/login?ui=v2&theme=dark');
      expect(axios.post).not.toHaveBeenCalledWith('/api/slip/bet', expect.anything());
    });

    it('offers "Log in to bet" on the Live tab as well', async () => {
      await renderRouted();
      await screen.findByLabelText('Wager for PRE-MATCH SLIP');

      openTab('Live');
      fireEvent.click(screen.getByRole('button', { name: 'Log in to bet' }));

      expect(screen.getByTestId('location')).toHaveTextContent(/^\/login$/);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it.each([
      ['a guest', null],
      ['a signed-in user', { id: 'user-1' }],
    ])('shows %s the same empty-state copy', async (_label, currentUser) => {
      boardsResponse = { [BET_KIND.PRE_MATCH]: null, [BET_KIND.LIVE]: null };

      await renderRouted({ currentUser });
      await screen.findByText('Build your pre-match slip');

      expect(screen.getByText('Pick pre-match odds from the events page to compose your slip.')).toBeInTheDocument();
      expect(screen.getByText('Build your live slip')).toBeInTheDocument();
      expect(screen.getByText('Choose an in-play market to keep live bets separate from pre-match picks.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Log in to bet' })).not.toBeInTheDocument();
    });

    it.each([
      ['null', null],
      ['null boards', { [BET_KIND.PRE_MATCH]: null, [BET_KIND.LIVE]: null }],
      ['an empty object', {}],
    ])('renders an empty tabbed slip without an error when an older API answers a guest with %s', async (_label, payload) => {
      boardsResponse = payload;

      await renderRouted();
      await screen.findByText('Build your pre-match slip');

      expect(screen.getByRole('tablist', { name: 'Slip' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Pre-match' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Live' })).toHaveAttribute('aria-selected', 'false');
      expect(document.getElementById('slip-panel-LIVE')).toHaveTextContent('Build your live slip');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('tells a guest when the slip cannot be loaded and recovers on the next refresh', async () => {
      let boardsAvailable = false;
      axios.get.mockImplementation((url) => {
        if (url === '/api/slip/boards') {
          return boardsAvailable
            ? Promise.resolve({ data: boardsResponse })
            : Promise.reject(buildAxiosError({ status: 503 }));
        }

        return Promise.reject(new Error(`Unexpected GET ${url}`));
      });

      const { rerender } = await renderRouted();

      expect(await screen.findByRole('alert')).toHaveTextContent(GUEST_LOAD_ERROR);
      expect(screen.getByRole('tablist', { name: 'Slip' })).toBeInTheDocument();

      boardsAvailable = true;
      rerender(routedElement({ refreshSignal: 1 }));
      await advanceTime(REFRESH_DELAY_MS);

      await screen.findByLabelText('Wager for PRE-MATCH SLIP');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('auth transitions', () => {
    it('carries wagers typed as a guest over to the matching kind after login', async () => {
      const { rerender } = await renderRouted();
      fireEvent.change(await screen.findByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '12' } });
      openTab('Live');
      fireEvent.change(screen.getByLabelText('Wager for LIVE SLIP'), { target: { value: '7' } });

      // Login refreshes the slip while the guest is still shown, then the user arrives; on the
      // user's first load the server merges the guest drafts into the user's boards.
      rerender(routedElement({ refreshSignal: 1 }));
      boardsResponse = getBoardsPayload({
        [BET_KIND.PRE_MATCH]: buildBoard(BET_KIND.PRE_MATCH, {
          _id: 'user-pre-match-1',
          rows: [buildRow({ oddsName: 'Team A' }), buildRow({ oddsName: 'Team B' })],
        }),
      });
      await act(async () => {
        rerender(routedElement({ currentUser: { id: 'user-1' }, refreshSignal: 1 }));
      });

      expect(await screen.findByRole('button', { name: 'BET!' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Log in to bet' })).not.toBeInTheDocument();
      // The login keeps the tab the guest was on and carries each wager to its own kind.
      expect(screen.getByRole('tab', { name: 'Live (1)' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toHaveValue(7);
      openTab('Pre-match');
      expect(screen.getByLabelText('Wager for PRE-MATCH SLIP')).toHaveValue(12);
      expect(screen.getByRole('tab', { name: 'Pre-match (2)' })).toBeInTheDocument();

      // The guest refresh that the login scheduled belongs to the old generation and never runs.
      await advanceTime(REFRESH_DELAY_MS * 2);
      expect(getRequestCount('/api/slip/boards')).toBe(2);
    });

    it.each([
      ['after the user slip has loaded', 'userFirst'],
      ['while the user slip is still loading', 'guestFirst'],
    ])('drops a guest slip response that arrives %s', async (_label, order) => {
      const guestLoad = createDeferred();
      const userLoad = createDeferred();
      const pendingLoads = [guestLoad, userLoad];
      axios.get.mockImplementation((url) => {
        if (url === '/api/slip/boards') {
          return pendingLoads.shift().promise;
        }

        return url === '/api/bet'
          ? Promise.resolve({ data: [] })
          : Promise.reject(new Error(`Unexpected GET ${url}`));
      });
      const slipWith = (oddsName, boardId) => getBoardsPayload({
        [BET_KIND.PRE_MATCH]: buildBoard(BET_KIND.PRE_MATCH, {
          _id: boardId,
          rows: [buildRow({ oddsName })],
        }),
      });

      const { rerender } = await renderRouted();
      expect(getRequestCount('/api/slip/boards')).toBe(1);
      await act(async () => {
        rerender(routedElement({ currentUser: { id: 'user-1' } }));
      });
      expect(getRequestCount('/api/slip/boards')).toBe(2);

      const answerGuest = () => act(async () => {
        guestLoad.resolve({ data: slipWith('Guest Team', 'guest-pre-match-1') });
      });
      const answerUser = () => act(async () => {
        userLoad.resolve({ data: slipWith('User Team', 'user-pre-match-1') });
      });

      if (order === 'guestFirst') {
        await answerGuest();
        expect(screen.queryByText('Guest Team')).not.toBeInTheDocument();
        expect(screen.getByText('Loading pre-match slip…')).toBeInTheDocument();
        await answerUser();
      } else {
        await answerUser();
        await answerGuest();
      }

      expect(await screen.findByText('User Team')).toBeInTheDocument();
      expect(screen.queryByText('Guest Team')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'BET!' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Log in to bet' })).not.toBeInTheDocument();
    });

    it('clears boards, wagers and pending state on logout and shows the empty guest slip', async () => {
      boardsResponse = getBoardsPayload({
        [BET_KIND.LIVE]: getSubmittedBoard(BET_KIND.LIVE, { _id: 'live-submitted-1' }),
      });
      betsResponse = [{ slipId: 'live-submitted-1', status: BET_STATUS.PENDING }];
      const onSelectionKeysChange = jest.fn();
      const { rerender } = await renderRouted({ currentUser: { id: 'user-1' }, onSelectionKeysChange });
      await screen.findByText('Awaiting live moderation and approval…');
      fireEvent.change(screen.getByLabelText('Wager for PRE-MATCH SLIP'), { target: { value: '12' } });
      expect(onSelectionKeysChange.mock.calls[onSelectionKeysChange.mock.calls.length - 1][0].size).toBe(2);

      const guestLoad = createDeferred();
      // The guest load starts in an effect right after the first commit for the guest, before the previous
      // user's records are reset, so what is on screen then shows whether anything of the user lingers.
      let screenAtGuestLoad = null;
      axios.get.mockImplementationOnce(() => {
        screenAtGuestLoad = {
          text: document.body.textContent,
          tabs: screen.getAllByRole('tab').map((tab) => tab.textContent),
        };
        return guestLoad.promise;
      });
      const callsBeforeLogout = onSelectionKeysChange.mock.calls.length;
      await act(async () => {
        rerender(routedElement({ currentUser: null, onSelectionKeysChange }));
      });

      // Nothing of the previous user is shown or highlighted for the guest, not even for one commit.
      expect(screenAtGuestLoad.tabs).toEqual(['Pre-match', 'Live']);
      expect(screenAtGuestLoad.text).not.toContain('Pre-match Clash');
      expect(screenAtGuestLoad.text).not.toContain('Awaiting live moderation and approval…');
      expect(screenAtGuestLoad.text).not.toContain('Log in to bet');
      expect(screen.getByText('Loading pre-match slip…')).toBeInTheDocument();
      expect(screen.queryByText('Pre-match Clash')).not.toBeInTheDocument();
      expect(screen.queryByText('Awaiting live moderation and approval…')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Log in to bet' })).not.toBeInTheDocument();
      const callsAfterLogout = onSelectionKeysChange.mock.calls.slice(callsBeforeLogout);
      expect(callsAfterLogout.length).toBeGreaterThan(0);
      callsAfterLogout.forEach(([keys]) => expect(keys.size).toBe(0));

      await act(async () => {
        guestLoad.resolve({ data: { [BET_KIND.PRE_MATCH]: null, [BET_KIND.LIVE]: null } });
      });

      await screen.findByText('Build your pre-match slip');
      expect(screen.getByRole('tab', { name: 'Pre-match' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Live' })).toBeInTheDocument();
      expect(document.getElementById('slip-panel-LIVE')).toHaveTextContent('Build your live slip');
      expect(screen.queryByText('Awaiting live moderation and approval…')).not.toBeInTheDocument();

      // The old user's submitted-board polling stopped with the session.
      const requestsAfterLogout = axios.get.mock.calls.length;
      await advanceTime(POLL_INTERVAL_MS * 3);
      expect(axios.get.mock.calls.length).toBe(requestsAfterLogout);

      // A guest who picks again starts from an empty wager and an editable board.
      boardsResponse = getBoardsPayload();
      rerender(routedElement({ currentUser: null, refreshSignal: 1 }));
      await advanceTime(REFRESH_DELAY_MS);
      expect(await screen.findByLabelText('Wager for PRE-MATCH SLIP')).toHaveValue(null);
      expect(screen.getByRole('button', { name: 'Log in to bet' })).toBeEnabled();
      openTab('Live');
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toHaveValue(null);
      expect(screen.getByLabelText('Wager for LIVE SLIP')).toBeEnabled();
    });
  });
});
