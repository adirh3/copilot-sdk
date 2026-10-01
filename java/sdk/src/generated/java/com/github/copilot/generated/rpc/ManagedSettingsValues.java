/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from: api.schema.json

package com.github.copilot.generated.rpc;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.github.copilot.CopilotExperimental;
import javax.annotation.processing.Generated;

/**
 * Typed effective values of managed settings. Each field mirrors the managed-settings schema key of the same name; more keys are added as they are typed.
 *
 * @apiNote This type is experimental and may change in a future version.
 *
 * @since 1.0.0
 */
@CopilotExperimental
@javax.annotation.processing.Generated("copilot-sdk-codegen")
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record ManagedSettingsValues(
    /** Managed default model identifier, as configured. New sessions start with it; it can name a model the account cannot use, so hosts match it against the listed models. */
    @JsonProperty("model") String model,
    /** Managed Auto routing preference, used when the selected model is `auto`. */
    @JsonProperty("autoTier") AutoTier autoTier
) {
}
