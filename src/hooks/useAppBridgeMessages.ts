import {
  useBridgeMessages,
  type UseBridgeMessagesOptions,
} from "./useBridgeMessages";

export type UseAppBridgeMessagesOptions = UseBridgeMessagesOptions["ctx"] &
  Pick<UseBridgeMessagesOptions, "bootLayout" | "onBootError">;

export function useAppBridgeMessages({
  bootLayout,
  onBootError,
  ...ctx
}: UseAppBridgeMessagesOptions): void {
  useBridgeMessages({
    bootLayout,
    onBootError,
    ctx,
  });
}
