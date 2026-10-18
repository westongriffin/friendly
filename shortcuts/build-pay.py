# Builds "Friendly Pay": input is JSON {"to": "+15551234567", "amt": "9.65", "note": "White Box Roastery Co."}.
# Runs Shortcuts' Send Payment action (identifier is.workflow.actions.venmo.pay, class WFHandlePaymentIntentAction,
# default app com.apple.PassKit.PassKitIntentsExtension = Apple Pay / Apple Cash) with that person and amount
# filled in, then opens Friendly again. Apple still shows its own confirm sheet (Face ID); nothing sends silently.
# TEST=1 swaps the payment for a text line, to check the plumbing on a Mac.
import plistlib, uuid, sys
TEST = len(sys.argv) > 2 and sys.argv[2] == "test"
U = lambda: str(uuid.uuid4()).upper()
u_dict, u_to, u_amt, u_note = U(), U(), U(), U()
att = lambda uid, name: {"Value": {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": name}, "WFSerializationType": "WFTextTokenAttachment"}
ref = lambda uid, name: {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": name}
tok = lambda parts: {"Value": {"string": "".join("￼" if isinstance(p, dict) else p for p in parts),
    "attachmentsByRange": {f"{{{sum(1 if isinstance(q, dict) else len(q) for q in parts[:i])}, 1}}": p for i, p in enumerate(parts) if isinstance(p, dict)}},
    "WFSerializationType": "WFTextTokenString"}
A = lambda ident, **p: {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": p}
acts = [
  A("is.workflow.actions.detect.dictionary", UUID=u_dict, WFInput={"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}),
  A("is.workflow.actions.getvalueforkey", UUID=u_to, CustomOutputName="Person", WFDictionaryKey="to", WFInput=att(u_dict, "Dictionary")),
  A("is.workflow.actions.getvalueforkey", UUID=u_amt, CustomOutputName="Amount", WFDictionaryKey="amt", WFInput=att(u_dict, "Dictionary")),
  A("is.workflow.actions.getvalueforkey", UUID=u_note, CustomOutputName="Note", WFDictionaryKey="note", WFInput=att(u_dict, "Dictionary")),
]
if TEST:
  acts.append(A("is.workflow.actions.gettext", UUID=U(), WFTextActionText=tok(["PAY ", ref(u_to, "Person"), " $", ref(u_amt, "Amount"), " :: ", ref(u_note, "Note")])))
else:
  acts.append(A("is.workflow.actions.venmo.pay", UUID=U(), ShowWhenRun=True,
    WFVenmoActionRecipients={"Value": ref(u_to, "Person"), "WFSerializationType": "WFTextTokenAttachment"},
    WFVenmoActionAmount=tok([ref(u_amt, "Amount")]),
    WFVenmoActionNote=tok([ref(u_note, "Note")])))
  acts.append(A("is.workflow.actions.openapp", WFAppIdentifier="com.officialfriendly.app",
    WFSelectedApp={"BundleIdentifier": "com.officialfriendly.app", "Name": "Friendly", "TeamIdentifier": "L7H9872BR2"}))
# An older client version lets Shortcuts' own migration turn the amount text into its currency field on import.
wf = {"WFWorkflowClientVersion": "1146.14", "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
  "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59446},
  "WFWorkflowImportQuestions": [], "WFWorkflowTypes": [], "WFQuickActionSurfaces": [],
  "WFWorkflowInputContentItemClasses": ["WFStringContentItem"], "WFWorkflowHasShortcutInputVariables": True,
  "WFWorkflowOutputContentItemClasses": ["WFStringContentItem"] if TEST else [], "WFWorkflowHasOutputFallback": False, "WFWorkflowActions": acts}
if TEST: acts.append(A("is.workflow.actions.output", WFOutput=tok([ref(acts[-1]["WFWorkflowActionParameters"]["UUID"], "Text")])))
plistlib.dump(wf, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)
print("wrote", sys.argv[1], len(acts), "actions")
