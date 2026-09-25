import { ApiError, NoTokenError } from '../api/client.ts';

/** Turns a failure into a sentence that says what to do next. */
export function friendlyError(error: unknown): string {
  if (error instanceof NoTokenError) {
    return "The extension hasn't picked up your Power Automate sign-in yet. Refresh this page (F5), wait for it to load, then analyse again.";
  }
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401:
        return 'Your sign-in has expired. Refresh this page (F5), then analyse again.';
      case 403:
        return "You don't have access to read this flow's definition. Ask its owner to share it with you, or an environment admin to check it.";
      case 404:
        return "This flow wasn't found. It may have been deleted, or it belongs to an environment you can't read.";
      case 429:
        return 'Power Automate is limiting requests right now. Wait a minute and try again.';
      default:
        return error.status >= 500
          ? `Power Automate returned an error (${error.status}). Try again in a moment.`
          : error.message;
    }
  }
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return "Couldn't reach Power Automate. Check your connection (or VPN/proxy) and try again.";
  }
  if (error instanceof Error && error.name === 'FlowParseError') {
    return `This flow's definition couldn't be read: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
