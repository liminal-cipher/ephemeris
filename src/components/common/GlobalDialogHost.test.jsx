import { act, render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import GlobalDialogHost from './GlobalDialogHost'
import { showConfirm, useDialogStore } from '../../store/dialogStore'

afterEach(() => { cleanup(); useDialogStore.setState({ confirmState: null, toasts: [] }); localStorage.clear() })

it('keeps a rejected confirmation open, permits retry and only then records the preference', async () => {
  const onConfirm = vi.fn().mockRejectedValueOnce(new Error('Synthetic storage failure')).mockResolvedValueOnce()
  showConfirm({ title: 'Save change', showNeverAskKey: 'synthetic-skip', onConfirm })
  render(<GlobalDialogHost />)
  await userEvent.click(screen.getByLabelText('Never ask again'))
  await userEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic storage failure')
  expect(localStorage.getItem('synthetic-skip')).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Save change' })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(localStorage.getItem('synthetic-skip')).toBe('true')
  expect(onConfirm).toHaveBeenCalledTimes(2)
})

it('waits for an asynchronous action and prevents duplicate confirmation or cancellation', async () => {
  let finish
  const onConfirm = vi.fn(() => new Promise(resolve => { finish = resolve }))
  showConfirm({ onConfirm })
  render(<GlobalDialogHost />)
  const confirm = screen.getByRole('button', { name: 'Confirm', exact: true })
  await userEvent.dblClick(confirm)
  expect(onConfirm).toHaveBeenCalledTimes(1)
  expect(confirm).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('dialog')).toBeVisible()
  await act(async () => finish())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('reports a skipped confirmation failure without an unhandled rejection', async () => {
  localStorage.setItem('synthetic-skip', 'true')
  render(<GlobalDialogHost />)
  await act(async () => showConfirm({ showNeverAskKey: 'synthetic-skip', onConfirm: async () => { throw new Error('Synthetic rejection') } }))
  expect(screen.getByRole('status')).toHaveTextContent('Action failed: Synthetic rejection')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
