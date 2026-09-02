/**
 * Source page for fixtures/pf6/rendered-markup.html.
 *
 * Every element in the fixture is rendered by the installed @patternfly/react-core and
 * @patternfly/react-table packages. Nothing here writes markup by hand, so the fixture
 * cannot drift toward whatever the selectors happen to expect.
 *
 * Menus, selects, modals and popovers are rendered already open, because a closed
 * PatternFly overlay renders nothing at all and we need its markup in the fixture.
 *
 * Run scripts/render-pf6-markup.mjs to regenerate. This file is not part of the usabl
 * build: usabl does not depend on React or PatternFly.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  Button,
  DatePicker,
  Dropdown,
  DropdownItem,
  DropdownList,
  MenuToggle,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Nav,
  NavItem,
  NavList,
  Popover,
  Select,
  SelectList,
  SelectOption,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarToggleGroup,
  ToolbarFilter
} from '@patternfly/react-core';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import FilterIcon from '@patternfly/react-icons/dist/esm/icons/filter-icon';

const noop = () => {};

/** The plain kebab toggle, which is what a row action or a header help menu renders. */
function KebabDropdown() {
  return (
    <Dropdown
      isOpen
      onSelect={noop}
      onOpenChange={noop}
      toggle={(toggleRef) => (
        <MenuToggle
          ref={toggleRef}
          id="help-menu-menu-toggle"
          aria-label="Kebab toggle"
          variant="plain"
          isExpanded
          onClick={noop}
        >
          {'⋮'}
        </MenuToggle>
      )}
      ouiaId="KebabDropdown"
    >
      <DropdownList>
        <DropdownItem value={0} key="edit">
          Edit
        </DropdownItem>
        <DropdownItem value={1} key="delete">
          Delete
        </DropdownItem>
      </DropdownList>
    </Dropdown>
  );
}

/** The labelled dropdown toggle, the most common PatternFly menu trigger. */
function TextDropdown() {
  return (
    <Dropdown
      isOpen
      onSelect={noop}
      onOpenChange={noop}
      toggle={(toggleRef) => (
        <MenuToggle ref={toggleRef} id="actions-toggle" isExpanded onClick={noop}>
          Actions
        </MenuToggle>
      )}
      ouiaId="TextDropdown"
    >
      <DropdownList>
        <DropdownItem value={0} key="rename">
          Rename
        </DropdownItem>
      </DropdownList>
    </Dropdown>
  );
}

/** Select renders role="listbox" instead of role="menu", so both menu shapes are covered. */
function StatusSelect() {
  return (
    <Select
      id="status-select"
      isOpen
      selected="Running"
      onSelect={noop}
      onOpenChange={noop}
      toggle={(toggleRef) => (
        <MenuToggle ref={toggleRef} id="status-toggle" isExpanded onClick={noop}>
          Running
        </MenuToggle>
      )}
    >
      <SelectList>
        <SelectOption value="Running">Running</SelectOption>
        <SelectOption value="Stopped">Stopped</SelectOption>
      </SelectList>
    </Select>
  );
}

/** The typeahead and split button MenuToggle variants put the toggle on an inner button. */
function ToggleVariants() {
  return (
    <>
      <MenuToggle id="typeahead-toggle" variant="typeahead" aria-label="Typeahead toggle" isExpanded={false}>
        <input type="text" aria-label="Filter clusters" />
      </MenuToggle>
      <MenuToggle
        id="split-toggle"
        aria-label="Split button toggle"
        isExpanded={false}
        onClick={noop}
        splitButtonItems={[
          <Button key="primary" variant="primary">
            Launch
          </Button>
        ]}
      />
    </>
  );
}

/**
 * Two Modal triggers, both rendered by PatternFly's Button.
 *
 * The first is what PatternFly gives you by default: a plain Button wired to component state,
 * carrying nothing that says it opens a dialog. It is in the fixture to keep that gap visible.
 *
 * The second adds aria-expanded and aria-controls, which is the ARIA disclosure contract for a
 * control that shows a surface. PatternFly does not add them for you, but it does render them
 * when an app passes them, so this is still library output.
 */
function ModalWithTrigger() {
  return (
    <>
      <Button variant="primary" onClick={noop} ouiaId="ShowClusterModal" id="open-modal-button">
        Show cluster details
      </Button>
      <Button
        variant="secondary"
        onClick={noop}
        ouiaId="ShowClusterModalDisclosure"
        id="disclosure-modal-button"
        isExpanded={false}
        aria-controls="cluster-modal-box"
      >
        Show cluster details, labelled trigger
      </Button>
      <Modal isOpen onClose={noop} ouiaId="ClusterModal" aria-labelledby="cluster-modal-title" id="cluster-modal-box">
        <ModalHeader title="Cluster details" labelId="cluster-modal-title" />
        <ModalBody id="cluster-modal-body">Cluster c-1 is running.</ModalBody>
        <ModalFooter>
          <Button key="confirm" variant="primary" onClick={noop}>
            Confirm
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}

/** DatePicker is the one PatternFly component that declares aria-haspopup="dialog". */
function DateField() {
  return <DatePicker value="2026-01-01" aria-label="Start date" buttonAriaLabel="Toggle date picker" />;
}

/** Popover also renders role="dialog" and traps focus, and its trigger carries no marker. */
function HelpPopover() {
  return (
    <Popover
      isVisible
      shouldClose={noop}
      shouldOpen={noop}
      aria-label="Cluster help"
      headerContent={<div>About clusters</div>}
      bodyContent={<div>A cluster groups managed hosts.</div>}
    >
      <Button variant="plain" aria-label="More information" id="help-popover-trigger">
        ?
      </Button>
    </Popover>
  );
}

/** NavItem with a flyout is a PatternFly element that really does emit aria-haspopup="menu". */
function FlyoutNav() {
  return (
    <Nav>
      <NavList>
        <NavItem
          itemId="flyout-item"
          flyout={
            <Nav>
              <NavList>
                <NavItem itemId="flyout-child">Child</NavItem>
              </NavList>
            </Nav>
          }
        >
          Automation
        </NavItem>
      </NavList>
    </Nav>
  );
}

/**
 * ToolbarToggleGroup is the only PatternFly 6 component that emits aria-haspopup="true".
 * It only does so while expanded, and it portals its content into a ref that is null on the
 * first render, so expansion has to happen after mount exactly as a user click would do it.
 */
function FilterToolbar() {
  const [isExpanded, setIsExpanded] = useState(false);
  useEffect(() => setIsExpanded(true), []);
  return (
    <Toolbar id="cluster-toolbar" clearAllFilters={noop} isExpanded={isExpanded} toggleIsExpanded={noop}>
      <ToolbarContent>
        <ToolbarToggleGroup toggleIcon={<FilterIcon />} breakpoint="xl">
          <ToolbarFilter labels={['running']} deleteLabel={noop} categoryName="Status">
            <ToolbarItem>
              <Button variant="secondary">Status</Button>
            </ToolbarItem>
          </ToolbarFilter>
        </ToolbarToggleGroup>
      </ToolbarContent>
    </Toolbar>
  );
}

/** A second toolbar so the repeated-toolbar rule has something real to look at. */
function PaginationToolbar() {
  return (
    <Toolbar id="pagination-toolbar">
      <ToolbarContent>
        <ToolbarItem>
          <Button variant="link">Next</Button>
        </ToolbarItem>
      </ToolbarContent>
    </Toolbar>
  );
}

/** Table headers and row action kebabs, both rendered by @patternfly/react-table. */
function ClusterTable() {
  return (
    <Table aria-label="Clusters">
      <Thead>
        <Tr>
          <Th>Name</Th>
          <Th>Status</Th>
          <Th screenReaderText="Row actions" />
        </Tr>
      </Thead>
      <Tbody>
        <Tr>
          <Td dataLabel="Name">c-1</Td>
          <Td dataLabel="Status">Running</Td>
          <Td isActionCell>
            <ActionsColumn
              isActionsOpen
              items={[
                { title: 'Edit', onClick: noop },
                { title: 'Delete', onClick: noop }
              ]}
            />
          </Td>
        </Tr>
      </Tbody>
    </Table>
  );
}

/** Alert covers the toast live-region rule. */
function Alerts() {
  return (
    <>
      <div aria-live="polite" role="status" id="toast-region">
        <Alert variant="success" title="Cluster created" ouiaId="ContainedAlert" />
      </div>
      <Alert variant="warning" title="Sync is behind" ouiaId="LooseAlert" />
    </>
  );
}

function Page() {
  return (
    <main>
      <h1>PatternFly 6 rendered markup</h1>
      <KebabDropdown />
      <TextDropdown />
      <StatusSelect />
      <ToggleVariants />
      <ModalWithTrigger />
      <DateField />
      <HelpPopover />
      <FlyoutNav />
      <FilterToolbar />
      <PaginationToolbar />
      <ClusterTable />
      <Alerts />
    </main>
  );
}

// Modal and Popover only render after mount, so this has to be a real client render in a
// real browser. Server rendering would silently drop them from the fixture.
createRoot(document.getElementById('root')).render(<Page />);
