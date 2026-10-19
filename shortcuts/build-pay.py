# Builds "Friendly Pay" and two one-tap test copies.
#   python3 build-pay.py OUT main      -> "Friendly Pay": input is JSON from Friendly (pays the number)
#   python3 build-pay.py OUT main-name -> "Friendly Pay" paying a contact made from the vCard, so Apple shows the Friendly name
#                                         {"to": "+12145551234", "amt": "9.65", "note": "White Box Roastery Co. · Friendly", "vcf": "BEGIN:VCARD ..."}
#   python3 build-pay.py OUT number    -> test copy with Sarah's $1 built in, paying her number
#   python3 build-pay.py OUT name      -> test copy with Sarah's $1 built in, paying a contact made from the vCard,
#                                         so Apple's sheet can show her name instead of a bare number
# Send Payment is is.workflow.actions.venmo.pay (Apple Pay / Apple Cash is the default app). The amount goes in as
# {"Value": {"Unit": "USD", "Magnitude": <variable>}, "WFSerializationType": "WFQuantityFieldValue"} (WorkflowKit's own
# WFQuantityParameterState serialization). v1 passed text and Shortcuts ignored it (the text-to-quantity migration only
# runs for client versions below 1075).
# WHY v2-v4 crashed ("There was a problem running the shortcut"): a variable magnitude is fetched as an NSNumber, and a
# JSON number comes back as __NSCFNumber; WFHandlePaymentIntentAction then calls decimalNumberByRoundingAccordingToBehavior:
# on it, which only NSDecimalNumber has. Text is coerced through ContentKit's number detector, which returns an
# NSDecimalNumber (checked on a Mac against ContentKit on Oct 18 2026). So the amount is always passed through a Text
# action first, and Friendly sends it as text too.
# Apple still shows its own sheet and asks for Face ID; nothing is sent silently.
# The vCard -> Set Name -> Get Contacts steps were checked on a Mac on Oct 18: they produce "Sarah Ellerd" with her number.
import plistlib, uuid, sys, json
OUT, MODE = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "main")
U = lambda: str(uuid.uuid4()).upper()
u_src, u_dict, u_to, u_amt, u_note, u_vcf, u_file, u_c, u_amtx = (U() for _ in range(9))
ref = lambda uid, name, **extra: {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": name, **extra}
att = lambda r: {"Value": r, "WFSerializationType": "WFTextTokenAttachment"}
tok = lambda parts: {"Value": {"string": "".join("￼" if isinstance(p, dict) else p for p in parts),
    "attachmentsByRange": {f"{{{sum(1 if isinstance(q, dict) else len(q) for q in parts[:i])}, 1}}": p for i, p in enumerate(parts) if isinstance(p, dict)}},
    "WFSerializationType": "WFTextTokenString"}
A = lambda ident, **p: {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": p}
TEST = {"to": "+12147334408", "amt": "1.00", "note": "Friendly test",
        "vcf": "BEGIN:VCARD\nVERSION:3.0\nFN:Sarah Ellerd\nN:Sarah Ellerd;;;;\nTEL;TYPE=CELL:+12147334408\nEND:VCARD"}
acts = []
MAIN = MODE.startswith("main")
if MAIN:
  src = {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}
else:
  acts.append(A("is.workflow.actions.gettext", UUID=u_src, WFTextActionText=json.dumps(TEST)))
  src = att(ref(u_src, "Text"))
D = att(ref(u_dict, "Dictionary"))
acts += [
  A("is.workflow.actions.detect.dictionary", UUID=u_dict, WFInput=src),
  A("is.workflow.actions.getvalueforkey", UUID=u_to, CustomOutputName="Number", WFDictionaryKey="to", WFInput=D),
  A("is.workflow.actions.getvalueforkey", UUID=u_amt, CustomOutputName="Amount", WFDictionaryKey="amt", WFInput=D),
  A("is.workflow.actions.getvalueforkey", UUID=u_note, CustomOutputName="Note", WFDictionaryKey="note", WFInput=D),
  A("is.workflow.actions.gettext", UUID=u_amtx, CustomOutputName="Amount Text", WFTextActionText=tok([ref(u_amt, "Amount")])),
]
if MODE in ("name", "main-name"):
  acts += [
    A("is.workflow.actions.getvalueforkey", UUID=u_vcf, CustomOutputName="Card", WFDictionaryKey="vcf", WFInput=D),
    A("is.workflow.actions.setitemname", UUID=u_file, WFInput=att(ref(u_vcf, "Card")), WFName="Friendly.vcf"),
    A("is.workflow.actions.detect.contacts", UUID=u_c, WFInput=att(ref(u_file, "Renamed Item"))),
  ]
  recipients = att(ref(u_c, "Contacts"))
else:
  recipients = att(ref(u_to, "Number"))
acts.append(A("is.workflow.actions.venmo.pay", UUID=U(), ShowWhenRun=True, WFVenmoActionRecipients=recipients,
  WFVenmoActionAmount={"Value": {"Unit": "USD", "Magnitude": ref(u_amtx, "Amount Text")}, "WFSerializationType": "WFQuantityFieldValue"},
  WFVenmoActionNote=tok([ref(u_note, "Note")])))
if MAIN:
  acts.append(A("is.workflow.actions.openapp", WFAppIdentifier="com.officialfriendly.app",
    WFSelectedApp={"BundleIdentifier": "com.officialfriendly.app", "Name": "Friendly", "TeamIdentifier": "L7H9872BR2"}))
wf = {"WFWorkflowClientVersion": "2607.0.2", "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
  "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59446},
  "WFWorkflowImportQuestions": [], "WFWorkflowTypes": [], "WFQuickActionSurfaces": [],
  "WFWorkflowInputContentItemClasses": ["WFStringContentItem"], "WFWorkflowHasShortcutInputVariables": MAIN,
  "WFWorkflowOutputContentItemClasses": [], "WFWorkflowHasOutputFallback": False, "WFWorkflowActions": acts}
plistlib.dump(wf, open(OUT, "wb"), fmt=plistlib.FMT_BINARY)
print("wrote", OUT, MODE, len(acts), "actions")
