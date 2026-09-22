// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './ChatComposer.js';
import { MAX_CHAT_ATTACHMENT_BYTES, type ChatAttachmentDraft } from './chat-attachments.js';

afterEach(cleanup);

function makeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(Math.min(size, 8))], name, { type });
  if (file.size !== size) Object.defineProperty(file, 'size', { value: size });
  return file;
}

const baseProps = {
  busy: false,
  forbidden: false,
  attachments: [] as readonly ChatAttachmentDraft[],
  attachmentNotice: null,
  onAttachFiles: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onSendMessage: vi.fn(),
} as const;

function attachmentFileInput(): HTMLElement {
  return screen.getByLabelText('Выбрать файлы для прикрепления');
}

describe('ChatComposer attachments', () => {
  it('accepts at most four attachments and explains the refusal in Russian', () => {
    const onAttachFiles = vi.fn();
    render(<ChatComposer {...baseProps} onAttachFiles={onAttachFiles} />);
    const files = [1, 2, 3, 4, 5].map((index) => makeFile(`photo-${index}.png`, 'image/png', 1024));

    fireEvent.change(attachmentFileInput(), { target: { files } });

    expect(onAttachFiles).toHaveBeenCalledTimes(1);
    expect(onAttachFiles.mock.calls[0]?.[0]).toHaveLength(4);
    expect(screen.getByRole('status')).toHaveTextContent('Можно прикрепить не более 4 файлов.');
  });

  it('refuses a file above the 15 MiB mirror limit without offering it for upload', () => {
    const onAttachFiles = vi.fn();
    render(<ChatComposer {...baseProps} onAttachFiles={onAttachFiles} />);

    fireEvent.change(attachmentFileInput(), {
      target: { files: [makeFile('big.png', 'image/png', MAX_CHAT_ATTACHMENT_BYTES + 1)] },
    });

    expect(onAttachFiles).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('«big.png»: файл больше 15 МБ.');
  });

  it('refuses an SVG upload in the picker instead of forwarding executable markup', () => {
    const onAttachFiles = vi.fn();
    render(<ChatComposer {...baseProps} onAttachFiles={onAttachFiles} />);

    fireEvent.change(attachmentFileInput(), {
      target: { files: [makeFile('vector.svg', 'image/svg+xml', 1024)] },
    });

    expect(onAttachFiles).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      '«vector.svg»: такой тип файла нельзя отправить в чате.',
    );
  });

  it('keeps the send button disabled while an attachment is uploading or scanning', () => {
    const onSendMessage = vi.fn();
    const uploading: ChatAttachmentDraft = {
      localId: 'local-1',
      fileName: 'photo.png',
      contentType: 'image/png',
      byteSize: 2048,
      mediaType: 'IMAGE',
      state: 'UPLOADING',
      progress: 40,
      mediaId: '55555555-5555-4555-8555-555555555555',
    };
    const { rerender } = render(
      <ChatComposer {...baseProps} attachments={[uploading]} onSendMessage={onSendMessage} />,
    );

    expect(screen.getByText('photo.png')).toBeVisible();
    const progress = screen.getByRole('progressbar', { name: 'Загрузка photo.png' });
    expect((progress as HTMLProgressElement).value).toBe(40);
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();

    rerender(
      <ChatComposer
        {...baseProps}
        attachments={[{ ...uploading, state: 'SCANNING' }]}
        onSendMessage={onSendMessage}
      />,
    );
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();

    rerender(
      <ChatComposer
        {...baseProps}
        attachments={[{ ...uploading, state: 'READY' }]}
        onSendMessage={onSendMessage}
      />,
    );
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled();
  });

  it('sends the body with READY attachment ids and keeps the attach control reachable', () => {
    const onSendMessage = vi.fn();
    const ready: ChatAttachmentDraft = {
      localId: 'local-1',
      fileName: 'photo.png',
      contentType: 'image/png',
      byteSize: 2048,
      mediaType: 'IMAGE',
      state: 'READY',
      progress: 100,
      mediaId: '55555555-5555-4555-8555-555555555555',
    };
    render(<ChatComposer {...baseProps} attachments={[ready]} onSendMessage={onSendMessage} />);

    const attachButton = screen.getByRole('button', { name: 'Прикрепить файл' });
    expect(attachButton).toBeEnabled();
    expect(attachmentFileInput()).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,*/*');

    fireEvent.change(screen.getByLabelText('Сообщение'), { target: { value: '  Смотри  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(onSendMessage).toHaveBeenCalledWith({
      body: 'Смотри',
      attachmentIds: ['55555555-5555-4555-8555-555555555555'],
    });
  });

  it('lets a chip be removed by keyboard-friendly button activation', () => {
    const onRemoveAttachment = vi.fn();
    const ready: ChatAttachmentDraft = {
      localId: 'local-1',
      fileName: 'договор.pdf',
      contentType: 'application/pdf',
      byteSize: 2 * 1024 * 1024,
      mediaType: 'FILE',
      state: 'READY',
      progress: 100,
      mediaId: '55555555-5555-4555-8555-555555555555',
    };
    render(
      <ChatComposer {...baseProps} attachments={[ready]} onRemoveAttachment={onRemoveAttachment} />,
    );

    expect(screen.getByText('2 МБ', { exact: false })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Убрать договор.pdf' }));

    expect(onRemoveAttachment).toHaveBeenCalledWith('local-1');
  });
});
