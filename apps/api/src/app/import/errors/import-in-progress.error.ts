import { CallerFacingError } from '@ghostfolio/api/errors/caller-facing.error';

export class ImportInProgressError extends CallerFacingError {
  public constructor(
    message = 'Another import of this user is still in progress. Please retry later.'
  ) {
    super(message);

    this.name = 'ImportInProgressError';
  }
}
