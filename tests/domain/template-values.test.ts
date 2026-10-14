import { expect, test } from 'vitest';
import { createDocument, validateDocument } from '../../src/domain';

test('invalid typography in templates and instance overrides always blocks a document', () => {
  const document = createDocument('Invalid template');
  const label = document.components.button!.templateNodes['button-label']!;
  if (label.kind !== 'text') throw new Error('Expected default button text template.');
  label.textStyle.weight = 1001;
  expect(validateDocument(document).ok).toBe(false);
});
