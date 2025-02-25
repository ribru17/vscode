/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { AuthenticationSession, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ChatContextKeys } from '../common/chatContextKeys.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IRequestContext } from '../../../../base/parts/request/common/request.js';
import { IGitHubEntitlement } from '../../../../base/common/product.js';
import { timeout } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { CHAT_CATEGORY } from './actions/chatActions.js';
import { showChatView, ChatViewId } from './chat.js';
import { IChatAgentService } from '../common/chatAgents.js';
import { Event } from '../../../../base/common/event.js';
import product from '../../../../platform/product/common/product.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IChatViewsWelcomeContributionRegistry, ChatViewsWelcomeExtensions } from './viewsWelcome/chatViewsWelcome.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

const defaultChat = {
	extensionId: product.defaultChatAgent?.extensionId ?? '',
	name: product.defaultChatAgent?.name ?? '',
	providerId: product.defaultChatAgent?.providerId ?? '',
	providerName: product.defaultChatAgent?.providerName ?? '',
	providerScopes: product.defaultChatAgent?.providerScopes ?? [],
	icon: Codicon[product.defaultChatAgent?.icon as keyof typeof Codicon ?? 'commentDiscussion'],
	documentationUrl: product.defaultChatAgent?.documentationUrl ?? '',
	gettingStartedCommand: product.defaultChatAgent?.gettingStartedCommand ?? '',
	welcomeTitle: product.defaultChatAgent?.welcomeTitle ?? '',
};

type ChatSetupEntitlementEnablementClassification = {
	entitled: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Flag indicating if the user is chat setup entitled' };
	trial: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Flag indicating if the user is subscribed to chat trial' };
	owner: 'bpasero';
	comment: 'Reporting if the user is chat setup entitled';
};

type ChatSetupEntitlementEnablementEvent = {
	entitled: boolean;
	trial: boolean;
};

type InstallChatClassification = {
	owner: 'bpasero';
	comment: 'Provides insight into chat installation.';
	installResult: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the extension was installed successfully, cancelled or failed to install.' };
	signedIn: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the user did sign in prior to installing the extension.' };
};
type InstallChatEvent = {
	installResult: 'installed' | 'cancelled' | 'failedInstall' | 'failedNotSignedIn';
	signedIn: boolean;
};

class ChatSetupContribution extends Disposable implements IWorkbenchContribution {

	private readonly chatSetupSignedInContextKey = ChatContextKeys.ChatSetup.signedIn.bindTo(this.contextKeyService);
	private readonly chatSetupEntitledContextKey = ChatContextKeys.ChatSetup.entitled.bindTo(this.contextKeyService);

	private readonly chatSetupState = this.instantiationService.createInstance(ChatSetupState);

	private resolvedEntitlement: boolean | undefined = undefined;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IProductService private readonly productService: IProductService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IRequestService private readonly requestService: IRequestService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();

		const entitlement = this.productService.gitHubEntitlement;
		if (!entitlement) {
			return;
		}

		this.registerChatWelcome();

		this.registerEntitlementListeners(entitlement);
		this.registerAuthListeners(entitlement);

		this.checkExtensionInstallation(entitlement);
	}

	private registerChatWelcome(): void {

		// Setup: Triggered (signed-out)
		Registry.as<IChatViewsWelcomeContributionRegistry>(ChatViewsWelcomeExtensions.ChatViewsWelcomeRegistry).register({
			title: defaultChat.welcomeTitle,
			when: ContextKeyExpr.and(
				ChatContextKeys.ChatSetup.triggered,
				ChatContextKeys.ChatSetup.signedIn.negate(),
				ChatContextKeys.ChatSetup.signingIn.negate(),
				ChatContextKeys.ChatSetup.installing.negate(),
				ChatContextKeys.extensionInvalid.negate(),
				ChatContextKeys.panelParticipantRegistered.negate()
			)!,
			icon: defaultChat.icon,
			content: new MarkdownString(`${localize('setupContent', "{0} is your AI pair programmer that helps you write code faster and smarter.", defaultChat.name)}\n\n[${localize('signInAndSetup', "Sign in to use {0}", defaultChat.name)}](command:${ChatSetupSignInAndInstallChatAction.ID})\n\n[${localize('learnMore', "Learn More")}](${defaultChat.documentationUrl}) | [${localize('hideSetup', "Hide")}](command:${ChatSetupHideAction.ID} "${localize('hideSetup', "Hide")}")`, { isTrusted: true }),
		});

		// Setup: Triggered (signed-in)
		Registry.as<IChatViewsWelcomeContributionRegistry>(ChatViewsWelcomeExtensions.ChatViewsWelcomeRegistry).register({
			title: defaultChat.welcomeTitle,
			when: ContextKeyExpr.and(
				ChatContextKeys.ChatSetup.triggered,
				ChatContextKeys.ChatSetup.signedIn,
				ChatContextKeys.ChatSetup.signingIn.negate(),
				ChatContextKeys.ChatSetup.installing.negate(),
				ChatContextKeys.extensionInvalid.negate(),
				ChatContextKeys.panelParticipantRegistered.negate()
			)!,
			icon: defaultChat.icon,
			content: new MarkdownString(`${localize('setupContent', "{0} is your AI pair programmer that helps you write code faster and smarter.", defaultChat.name)}\n\n[${localize('setup', "Install {0}", defaultChat.name)}](command:${ChatSetupInstallAction.ID})\n\n[${localize('learnMore', "Learn More")}](${defaultChat.documentationUrl}) | [${localize('hideSetup', "Hide")}](command:${ChatSetupHideAction.ID} "${localize('hideSetup', "Hide")}")`, { isTrusted: true }),
		});

		// Setup: Signing-in
		Registry.as<IChatViewsWelcomeContributionRegistry>(ChatViewsWelcomeExtensions.ChatViewsWelcomeRegistry).register({
			title: defaultChat.welcomeTitle,
			when: ContextKeyExpr.and(
				ChatContextKeys.ChatSetup.signingIn,
				ChatContextKeys.extensionInvalid.negate(),
				ChatContextKeys.panelParticipantRegistered.negate()
			)!,
			icon: defaultChat.icon,
			progress: localize('setupChatSigningIn', "Signing in to {0}...", defaultChat.providerName),
			content: new MarkdownString(`${localize('setupContent', "{0} is your AI pair programmer that helps you write code faster and smarter.", defaultChat.name)}`, { isTrusted: true }),
		});

		// Setup: Installing
		Registry.as<IChatViewsWelcomeContributionRegistry>(ChatViewsWelcomeExtensions.ChatViewsWelcomeRegistry).register({
			title: defaultChat.welcomeTitle,
			when: ChatContextKeys.ChatSetup.installing,
			icon: defaultChat.icon,
			progress: localize('setupChatInstalling', "Setting up Chat for you..."),
			content: new MarkdownString(`${localize('setupContent', "{0} is your AI pair programmer that helps you write code faster and smarter.", defaultChat.name)}`, { isTrusted: true }),
		});
	}

	private registerEntitlementListeners(entitlement: IGitHubEntitlement): void {
		this._register(this.extensionService.onDidChangeExtensions(result => {
			for (const extension of result.removed) {
				if (ExtensionIdentifier.equals(entitlement.extensionId, extension.identifier)) {
					this.chatSetupState.update({ chatInstalled: false });
					break;
				}
			}

			for (const extension of result.added) {
				if (ExtensionIdentifier.equals(entitlement.extensionId, extension.identifier)) {
					this.chatSetupState.update({ chatInstalled: true });
					break;
				}
			}
		}));

		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (e.providerId === entitlement.providerId) {
				if (e.event.added?.length) {
					this.resolveEntitlement(entitlement, e.event.added[0]);
				} else if (e.event.removed?.length) {
					this.chatSetupEntitledContextKey.set(false);
				}
			}
		}));

		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(async e => {
			if (e.id === entitlement.providerId) {
				this.resolveEntitlement(entitlement, (await this.authenticationService.getSessions(e.id))[0]);
			}
		}));
	}

	private registerAuthListeners(entitlement: IGitHubEntitlement): void {
		const hasProviderSessions = async () => {
			const sessions = await this.authenticationService.getSessions(entitlement.providerId);
			return sessions.length > 0;
		};

		const handleDeclaredAuthProviders = async () => {
			if (this.authenticationService.declaredProviders.find(p => p.id === entitlement.providerId)) {
				this.chatSetupSignedInContextKey.set(await hasProviderSessions());
			}
		};
		this._register(this.authenticationService.onDidChangeDeclaredProviders(handleDeclaredAuthProviders));
		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(handleDeclaredAuthProviders));

		handleDeclaredAuthProviders();

		this._register(this.authenticationService.onDidChangeSessions(async ({ providerId }) => {
			if (providerId === entitlement.providerId) {
				this.chatSetupSignedInContextKey.set(await hasProviderSessions());
			}
		}));
	}

	private async resolveEntitlement(entitlement: IGitHubEntitlement, session: AuthenticationSession | undefined): Promise<void> {
		if (!session) {
			return;
		}

		const entitled = await this.doResolveEntitlement(entitlement, session);
		this.chatSetupEntitledContextKey.set(entitled);
	}

	private async doResolveEntitlement(entitlement: IGitHubEntitlement, session: AuthenticationSession): Promise<boolean> {
		if (typeof this.resolvedEntitlement === 'boolean') {
			return this.resolvedEntitlement;
		}

		const cts = new CancellationTokenSource();
		this._register(toDisposable(() => cts.dispose(true)));

		let context: IRequestContext;
		try {
			context = await this.requestService.request({
				type: 'GET',
				url: entitlement.entitlementUrl,
				headers: {
					'Authorization': `Bearer ${session.accessToken}`
				}
			}, cts.token);
		} catch (error) {
			return false;
		}

		if (context.res.statusCode && context.res.statusCode !== 200) {
			return false;
		}

		const result = await asText(context);
		if (!result) {
			return false;
		}

		let parsedResult: any;
		try {
			parsedResult = JSON.parse(result);
		} catch (err) {
			return false; //ignore
		}

		this.resolvedEntitlement = Boolean(parsedResult[entitlement.enablementKey]);
		const trial = parsedResult[entitlement.trialKey] === entitlement.trialValue;
		this.telemetryService.publicLog2<ChatSetupEntitlementEnablementEvent, ChatSetupEntitlementEnablementClassification>('chatInstallEntitlement', {
			entitled: this.resolvedEntitlement,
			trial
		});

		return this.resolvedEntitlement;
	}

	private async checkExtensionInstallation(entitlement: IGitHubEntitlement): Promise<void> {
		const extensions = await this.extensionManagementService.getInstalled();

		const chatInstalled = !!extensions.find(value => ExtensionIdentifier.equals(value.identifier.id, entitlement.extensionId));
		this.chatSetupState.update({ chatInstalled });
	}
}

class ChatSetupState {

	private static readonly CHAT_SETUP_TRIGGERD = 'chat.setupTriggered';
	private static readonly CHAT_EXTENSION_INSTALLED = 'chat.extensionInstalled';

	private readonly chatSetupTriggeredContext = ChatContextKeys.ChatSetup.triggered.bindTo(this.contextKeyService);

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService
	) {
		this.updateContext();
	}

	update(context: { triggered: boolean }): void;
	update(context: { chatInstalled?: boolean }): void;
	update(context: { triggered?: boolean; chatInstalled?: boolean }): void {
		if (typeof context.chatInstalled === 'boolean') {
			this.storageService.store(ChatSetupState.CHAT_EXTENSION_INSTALLED, context.chatInstalled, StorageScope.PROFILE, StorageTarget.MACHINE);
		}

		if (typeof context.triggered === 'boolean') {
			if (context.triggered) {
				this.storageService.store(ChatSetupState.CHAT_SETUP_TRIGGERD, true, StorageScope.PROFILE, StorageTarget.MACHINE);
			} else {
				this.storageService.remove(ChatSetupState.CHAT_SETUP_TRIGGERD, StorageScope.PROFILE);
			}
		}

		this.updateContext();
	}

	private updateContext(): void {
		const chatSetupTriggered = this.storageService.getBoolean(ChatSetupState.CHAT_SETUP_TRIGGERD, StorageScope.PROFILE, false);
		const chatInstalled = this.storageService.getBoolean(ChatSetupState.CHAT_EXTENSION_INSTALLED, StorageScope.PROFILE, false);

		const showChatSetup = chatSetupTriggered && !chatInstalled;
		if (showChatSetup) {
			// this is ugly but fixes flicker from a previous chat install
			this.storageService.remove('chat.welcomeMessageContent.panel', StorageScope.APPLICATION);
			this.storageService.remove('interactive.sessions', this.workspaceContextService.getWorkspace().folders.length ? StorageScope.WORKSPACE : StorageScope.APPLICATION);
		}

		this.chatSetupTriggeredContext.set(showChatSetup);
	}
}

class ChatSetupTriggerAction extends Action2 {

	static readonly ID = 'workbench.action.chat.triggerSetup';
	static readonly TITLE = localize2('triggerChatSetup', "Trigger Chat Setup");

	constructor() {
		super({
			id: ChatSetupTriggerAction.ID,
			title: ChatSetupTriggerAction.TITLE,
			f1: false
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const instantiationService = accessor.get(IInstantiationService);

		instantiationService.createInstance(ChatSetupState).update({ triggered: true });

		showChatView(viewsService);
	}
}

class ChatSetupHideAction extends Action2 {

	static readonly ID = 'workbench.action.chat.hideSetup';
	static readonly TITLE = localize2('hideChatSetup', "Hide Chat Setup");

	constructor() {
		super({
			id: ChatSetupHideAction.ID,
			title: ChatSetupHideAction.TITLE,
			f1: false
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const viewsDescriptorService = accessor.get(IViewDescriptorService);
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const instantiationService = accessor.get(IInstantiationService);

		const location = viewsDescriptorService.getViewLocationById(ChatViewId);

		instantiationService.createInstance(ChatSetupState).update({ triggered: false });

		if (location === ViewContainerLocation.AuxiliaryBar) {
			const activeContainers = viewsDescriptorService.getViewContainersByLocation(location).filter(container => viewsDescriptorService.getViewContainerModel(container).activeViewDescriptors.length > 0);
			if (activeContainers.length === 0) {
				layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART); // hide if there are no views in the secondary sidebar
			}
		}
	}
}

class ChatSetupInstallAction extends Action2 {

	static readonly ID = 'workbench.action.chat.install';
	static readonly TITLE = localize2('installChat', "Install {0}", defaultChat.name);

	constructor() {
		super({
			id: ChatSetupInstallAction.ID,
			title: ChatSetupInstallAction.TITLE,
			category: CHAT_CATEGORY,
			menu: {
				id: MenuId.ChatCommandCenter,
				group: 'a_open',
				order: 0,
				when: ContextKeyExpr.and(
					ChatContextKeys.panelParticipantRegistered.negate(),
					ContextKeyExpr.or(
						ChatContextKeys.ChatSetup.entitled,
						ChatContextKeys.ChatSetup.signedIn
					)
				)
			}
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return ChatSetupInstallAction.install(accessor, false);
	}

	static async install(accessor: ServicesAccessor, signedIn: boolean) {
		const extensionsWorkbenchService = accessor.get(IExtensionsWorkbenchService);
		const productService = accessor.get(IProductService);
		const telemetryService = accessor.get(ITelemetryService);
		const contextKeyService = accessor.get(IContextKeyService);
		const viewsService = accessor.get(IViewsService);
		const chatAgentService = accessor.get(IChatAgentService);

		const setupInstallingContextKey = ChatContextKeys.ChatSetup.installing.bindTo(contextKeyService);

		let installResult: 'installed' | 'cancelled' | 'failedInstall';
		try {
			setupInstallingContextKey.set(true);
			showChatView(viewsService);

			await extensionsWorkbenchService.install(defaultChat.extensionId, {
				enable: true,
				isMachineScoped: false,
				installPreReleaseVersion: productService.quality !== 'stable'
			}, ChatViewId);

			installResult = 'installed';
		} catch (error) {
			installResult = isCancellationError(error) ? 'cancelled' : 'failedInstall';
		}

		telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult, signedIn });

		await Promise.race([timeout(2000), Event.toPromise(chatAgentService.onDidChangeAgents)]); // reduce flicker (https://github.com/microsoft/vscode-copilot/issues/9274)

		setupInstallingContextKey.reset();

		(await showChatView(viewsService))?.focusInput();
	}
}

class ChatSetupSignInAndInstallChatAction extends Action2 {

	static readonly ID = 'workbench.action.chat.signInAndInstall';
	static readonly TITLE = localize2('signInAndInstallChat', "Sign in to use {0}", defaultChat.name);

	constructor() {
		super({
			id: ChatSetupSignInAndInstallChatAction.ID,
			title: ChatSetupSignInAndInstallChatAction.TITLE,
			category: CHAT_CATEGORY,
			menu: {
				id: MenuId.ChatCommandCenter,
				group: 'a_open',
				order: 0,
				when: ContextKeyExpr.and(
					ChatContextKeys.panelParticipantRegistered.negate(),
					ChatContextKeys.ChatSetup.entitled.negate(),
					ChatContextKeys.ChatSetup.signedIn.negate()
				)
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const authenticationService = accessor.get(IAuthenticationService);
		const instantiationService = accessor.get(IInstantiationService);
		const telemetryService = accessor.get(ITelemetryService);
		const contextKeyService = accessor.get(IContextKeyService);
		const viewsService = accessor.get(IViewsService);
		const layoutService = accessor.get(IWorkbenchLayoutService);

		const hideSecondarySidebar = !layoutService.isVisible(Parts.AUXILIARYBAR_PART);

		const setupSigningInContextKey = ChatContextKeys.ChatSetup.signingIn.bindTo(contextKeyService);

		let session: AuthenticationSession | undefined;
		try {
			setupSigningInContextKey.set(true);
			showChatView(viewsService);
			session = await authenticationService.createSession(defaultChat.providerId, defaultChat.providerScopes);
		} catch (error) {
			// noop
		} finally {
			setupSigningInContextKey.reset();
		}

		if (session) {
			instantiationService.invokeFunction(accessor => ChatSetupInstallAction.install(accessor, true));
		} else {
			if (hideSecondarySidebar) {
				layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			}
			telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedNotSignedIn', signedIn: false });
		}
	}
}

registerAction2(ChatSetupTriggerAction);
registerAction2(ChatSetupHideAction);
registerAction2(ChatSetupInstallAction);
registerAction2(ChatSetupSignInAndInstallChatAction);

registerWorkbenchContribution2('workbench.chat.setup', ChatSetupContribution, WorkbenchPhase.BlockRestore);
