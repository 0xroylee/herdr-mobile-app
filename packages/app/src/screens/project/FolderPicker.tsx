import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import type { FolderSuggestion } from "../../model/startAgent.ts";
import { shortenHomeFolder } from "../../terminal/folder.ts";
import { Button } from "../../ui/components/Button.tsx";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Tag } from "../../ui/components/Tag.tsx";
import { Icon } from "../../ui/icon.tsx";
import { modalFrameTopInsetClass } from "../../ui/modal-frame.ts";
import { Text } from "../../ui/text.tsx";
import { transitionPickerVisibility } from "./viewState.ts";

const rowClasses = {
  rest: "min-h-[58px] flex-row items-center gap-3 px-3.5 py-2.5",
  pressed: "min-h-[58px] flex-row items-center gap-3 bg-raised px-3.5 py-2.5",
} as const;

export interface FolderPickerProps {
  folder: string;
  suggestions: readonly FolderSuggestion[];
  home: string | undefined;
  disabled: boolean;
  error?: string;
  openRequest?: number;
  trigger?: ReactNode;
  onSelect(folder: string): void;
}

export function FolderPicker({
  folder,
  suggestions,
  home,
  disabled,
  error,
  openRequest = 0,
  trigger,
  onSelect,
}: FolderPickerProps) {
  const [visible, setVisible] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [typedFolder, setTypedFolder] = useState(folder);
  const [typedError, setTypedError] = useState<string>();
  const lastOpenRequest = useRef(0);
  const dim = useCSSVariable("--color-dim");
  const placeholderColor = typeof dim === "string" ? dim : undefined;

  useEffect(() => {
    if (openRequest !== lastOpenRequest.current) {
      lastOpenRequest.current = openRequest;
      setTypedFolder(folder);
      setTypedError(undefined);
      setOtherOpen(false);
      setVisible((current) => transitionPickerVisibility(current, { type: "open", disabled }));
    }
  }, [disabled, folder, openRequest]);

  useEffect(() => {
    if (disabled) {
      setVisible((current) =>
        transitionPickerVisibility(current, { type: "availability-changed", disabled }),
      );
      setOtherOpen(false);
      setTypedError(undefined);
    }
  }, [disabled]);

  function openPicker() {
    setTypedFolder(folder);
    setTypedError(undefined);
    setOtherOpen(false);
    setVisible((current) => transitionPickerVisibility(current, { type: "open", disabled }));
  }

  function handleUseTypedFolder() {
    if (disabled) return;
    const nextFolder = typedFolder.trim();
    if (!isFolderSyntaxAllowed(nextFolder)) {
      setTypedError(
        nextFolder.length === 0
          ? "Choose a folder."
          : "Enter an absolute path or a path starting with ~/.",
      );
      return;
    }
    onSelect(nextFolder);
    setVisible(false);
  }

  return (
    <>
      {trigger ? (
        <Pressable
          accessibilityLabel="Choose folder"
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={openPicker}
          style={{ opacity: disabled ? 0.4 : 1 }}
        >
          {trigger}
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={openPicker}
        >
          {({ pressed }) => (
            <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
              <View className="min-w-0 flex-1">
                <Text variant="headline">Folder</Text>
                <Text numberOfLines={1} variant="mono" tone="dim">
                  {folder ? shortenHomeFolder(folder, home) : "Choose a folder"}
                </Text>
              </View>
              <Icon color="dim" name="chevron-right" size={17} />
            </View>
          )}
        </Pressable>
      )}
      {error ? (
        <View className="px-3.5 pb-2.5">
          <Text accessibilityRole="alert" variant="caption" tone="blocked">
            {error}
          </Text>
        </View>
      ) : null}
      <Modal
        animationType="slide"
        onRequestClose={() =>
          setVisible((current) => transitionPickerVisibility(current, { type: "close" }))
        }
        presentationStyle="pageSheet"
        visible={visible && !disabled}
      >
        <View className={`flex-1 bg-canvas px-3.5 ${modalFrameTopInsetClass(Platform.OS)}`}>
          <View className="flex-row items-center pb-2.5">
            <IconButton
              accessibilityLabel="Close folder picker"
              icon="x"
              onPress={() => setVisible(false)}
            />
            <Text variant="title">Choose folder</Text>
          </View>
          <ScrollView
            automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
            className="flex-1"
            contentContainerClassName="gap-3 pb-5"
            keyboardShouldPersistTaps="handled"
          >
            {suggestions.length > 0 ? (
              <ListGroup>
                {suggestions.map((suggestion) => {
                  const selected = suggestion.path === folder;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled, selected }}
                      disabled={disabled}
                      key={`${suggestion.source}:${suggestion.path}`}
                      onPress={() => {
                        onSelect(suggestion.path);
                        setVisible(false);
                      }}
                    >
                      {({ pressed }) => (
                        <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
                          <View className="min-w-0 flex-1">
                            <Text numberOfLines={1} variant="mono" tone="fg">
                              {shortenHomeFolder(suggestion.path, home)}
                            </Text>
                          </View>
                          {suggestion.source === "space" ? <Tag label="space folder" /> : null}
                          {selected ? <Icon color="fg" name="check" size={17} /> : null}
                        </View>
                      )}
                    </Pressable>
                  );
                })}
              </ListGroup>
            ) : null}
            <ListGroup>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={() => {
                  setOtherOpen(true);
                  setTypedError(undefined);
                }}
              >
                {({ pressed }) => (
                  <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
                    <View className="min-w-0 flex-1">
                      <Text variant="headline">Other…</Text>
                      <Text variant="subhead" tone="dim">
                        Enter an absolute path or ~/ path
                      </Text>
                    </View>
                    <Icon color="dim" name="chevron-right" size={17} />
                  </View>
                )}
              </Pressable>
            </ListGroup>
            {otherOpen ? (
              <View className="gap-2 rounded-card border-border bg-surface p-3.5">
                <Text variant="caption" tone="muted">
                  Folder path
                </Text>
                <TextInput
                  accessibilityLabel="Folder path"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-h-11 rounded-btn border-border bg-canvas px-3 font-mono text-[13px] leading-[20px] text-fg"
                  editable={!disabled}
                  onChangeText={(value) => {
                    setTypedFolder(value);
                    setTypedError(undefined);
                  }}
                  placeholder="~/src/herdr"
                  placeholderTextColor={placeholderColor}
                  style={{ borderWidth: HAIRLINE }}
                  value={typedFolder}
                />
                {typedError ? (
                  <Text accessibilityRole="alert" variant="caption" tone="blocked">
                    {typedError}
                  </Text>
                ) : null}
                <View className="flex-row justify-end">
                  <Button disabled={disabled} onPress={handleUseTypedFolder}>
                    <Text variant="button">Use folder</Text>
                  </Button>
                </View>
              </View>
            ) : null}
          </ScrollView>
          {error ? (
            <View className="pb-3">
              <Text accessibilityRole="alert" variant="caption" tone="blocked">
                {error}
              </Text>
            </View>
          ) : null}
        </View>
      </Modal>
    </>
  );
}

function isFolderSyntaxAllowed(folder: string): boolean {
  return folder.startsWith("/") || folder.startsWith("~/");
}
