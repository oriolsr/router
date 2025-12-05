# Layer Activation/Deactivation Feature

## Overview

The Vue Router now supports automatic activation and deactivation of components when navigating between layers (e.g., layer 0 and layer 1).

## How It Works

When you have multiple layers in your application:

- **Layer 0** - Main content (e.g., BillingAccount page)
- **Layer 1** - Overlay content (e.g., Modal or detail view with `next-layer` prop)

The router will automatically:

1. Call `deactivated()` on layer 0 components when layer 1 is rendered
2. Call `activated()` on layer 0 components when layer 1 is removed
